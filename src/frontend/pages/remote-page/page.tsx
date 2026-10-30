import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { CloudDownload, Link2, LogIn, RefreshCw, Send, ShieldCheck, Unlink, X } from "lucide-react";

import { api_fetch, DesktopApiError, open_event_stream } from "@frontend/app/desktop/desktop-api";
import { push_error_toast, push_toast } from "@frontend/app/feedback/desktop-toast";
import { useAppearance } from "@frontend/app/appearance/appearance-context";
import { useI18n } from "@frontend/app/locale/locale-context";
import { Badge } from "@frontend/shadcn/badge";
import { Input } from "@frontend/shadcn/input";
import { Spinner } from "@frontend/shadcn/spinner";
import { Textarea } from "@frontend/shadcn/textarea";
import { SegmentedToggle } from "@frontend/shadcn/segmented-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@frontend/shadcn/card";
import { AppButton } from "@frontend/widgets/app-button";
import { SegmentedProgress } from "@frontend/widgets/segmented-progress/segmented-progress";
import { format_local_timestamp } from "@shared/utils/format-local-timestamp";
import "@frontend/pages/remote-page/remote-page.css";

type RemoteCredential = {
  origin: string;
  token_tail: string;
  updated_at: string;
  source: "bridge" | "manual" | "login";
  expired: boolean;
};

type RemoteLoginStatus = "idle" | "running" | "succeeded" | "cancelled" | "timeout" | "unavailable";

type RemoteAuth = {
  default_origin: string;
  origins: RemoteCredential[];
  bridge: {
    enabled: boolean;
    status: {
      running: boolean;
      port: number | null;
      address: string | null;
      error: string | null;
    };
  };
  login: {
    status: RemoteLoginStatus;
    origin: string | null;
    started_at: string | null;
  };
};

type RemoteBinding = {
  origin: string;
  kind: "web" | "wenku";
  title: string;
  url: string;
  asset_path: string;
  chapter_count: number;
  synced_at: string;
};

type RemoteSource = {
  binding: RemoteBinding | null;
  asset_present: boolean;
  snapshot_present: boolean;
};

type RemoteChapterPlan = {
  index: number;
  kind: "preamble" | "chapter";
  title: string;
  status: "unchanged" | "modified" | "added" | "removed" | "ambiguous";
  old_index: number | null;
  added: number;
  modified: number;
  removed: number;
  inherited: number;
  would_lose: number;
};

type RemoteSyncPreview = {
  stash_id: string;
  created_at: string;
  expires_at: string;
  filename: string;
  previous_source: "snapshot" | "current_asset";
  snapshot_available: boolean;
  current_asset_changed: boolean;
  stats: {
    added: number;
    modified: number;
    removed: number;
    inherited: number;
    remote_inherited: number;
    would_lose: number;
    diverged: boolean;
    requires_alignment: boolean;
  };
  chapters: RemoteChapterPlan[];
};

type RemoteAlignRow = {
  row: number;
  src: string;
  src_hash: string;
  decision: "preserve" | "keep" | "retranslate";
  similarity: number;
  review: boolean;
  old_src: string | null;
  old_dst: string | null;
  old_status: string | null;
  remote_dst: string | null;
};

type RemoteAlignPreview = {
  stash_id: string;
  chapter: RemoteChapterPlan;
  rows: RemoteAlignRow[];
};

type RemoteWorkspaceChapter = {
  chapter_id: string;
  title: string;
  state: "pending" | "reading" | "uploading" | "uploaded" | "skipped" | "failed";
  ready: number;
  missing: number;
  message: string | null;
};

type RemoteWorkspaceSnapshot = {
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  totals: {
    chapters: number;
    uploaded: number;
    skipped: number;
    failed: number;
  };
  chapters: RemoteWorkspaceChapter[];
};

type SyncMode = "add_only" | "auto" | "manual";

type RowOverride = { action: "keep" | "retranslate"; src_hash: string };

// 后端不会为人工排除或预过滤跳过的行套用站点译文，界面保持同一口径。
const REMOTE_TRANSLATION_BLOCKED_STATUSES = new Set([
  "EXCLUDED",
  "RULE_SKIPPED",
  "LANGUAGE_SKIPPED",
  "DUPLICATED",
]);

/**
 * 远程小说页：站点凭据、工程绑定与同步、工作区上传集中在一个入口。
 * 页面只消费 API 事实；预览暂存在后端内存，应用时必须携带同一 stash。
 */
export function RemotePage(): JSX.Element {
  const { t } = useI18n();
  const { resolved_theme } = useAppearance();
  const [auth, set_auth] = useState<RemoteAuth | null>(null);
  const [source, set_source] = useState<RemoteSource | null>(null);
  const [bind_url, set_bind_url] = useState("");
  const [is_bind_busy, set_is_bind_busy] = useState(false);
  const [workspace, set_workspace] = useState<RemoteWorkspaceSnapshot | null>(null);
  const [token_input, set_token_input] = useState("");
  const [origin_input, set_origin_input] = useState("");
  const [is_auth_busy, set_is_auth_busy] = useState(false);
  const [bridge_pending, set_bridge_pending] = useState<"enable" | "disable" | null>(null);
  const [is_login_busy, set_is_login_busy] = useState(false);
  const [preview, set_preview] = useState<RemoteSyncPreview | null>(null);
  const [align, set_align] = useState<RemoteAlignPreview | null>(null);
  const [overrides, set_overrides] = useState<Map<number, RowOverride>>(() => new Map());
  const [sync_mode, set_sync_mode] = useState<SyncMode>("auto");
  const [is_sync_busy, set_is_sync_busy] = useState(false);
  const [is_workspace_starting, set_is_workspace_starting] = useState(false);
  const [is_workspace_cancelling, set_is_workspace_cancelling] = useState(false);
  // 桥接凭据指纹只在 SSE 推送里比较，首次读取不会误报“已接收”。
  const bridge_fingerprint = useRef<string | null>(null);
  const login_running = is_login_busy || auth?.login.status === "running";
  const workspace_running = workspace?.status === "running";

  /** 所有认证快照都经同一入口落状态，SSE 推送时才比较桥接凭据变化。 */
  const apply_auth = useCallback(
    (next: RemoteAuth, notify_bridge: boolean): void => {
      set_auth(next);
      const fingerprint = next.origins
        .filter((credential) => credential.source === "bridge")
        .map(
          (credential) => `${credential.origin}|${credential.token_tail}|${credential.updated_at}`,
        )
        .sort()
        .join(",");
      const previous = bridge_fingerprint.current;
      bridge_fingerprint.current = fingerprint;
      if (notify_bridge && previous !== null && previous !== fingerprint) {
        push_toast("success", t("remote_page.auth.bridge.received"));
      }
    },
    [t],
  );

  const refresh_auth = useCallback(async (): Promise<void> => {
    const payload = await api_fetch<{ auth: RemoteAuth }>("/api/remote/auth/status", {});
    apply_auth(payload.auth, false);
    set_origin_input((current) => (current === "" ? payload.auth.default_origin : current));
  }, [apply_auth]);

  const refresh_source = useCallback(async (): Promise<void> => {
    const payload = await api_fetch<{ source: RemoteSource }>("/api/remote/source/read", {});
    set_source(payload.source);
  }, []);

  /** 补绑定只提交地址；只有工程唯一的 TXT 正文资产且正文一致时后端才允许绑定，EPUB 需整本导入。 */
  async function bind_source(): Promise<void> {
    const url = bind_url.trim();
    if (url === "" || is_bind_busy) return;
    set_is_bind_busy(true);
    try {
      const payload = await api_fetch<{ source: RemoteSource }>("/api/remote/source/bind", {
        url,
      });
      set_source(payload.source);
      set_bind_url("");
      push_toast("success", t("remote_page.source.bind_success"));
    } catch (error) {
      if (error instanceof DesktopApiError && error.code === "remote.source_mismatch") {
        push_error_toast(t("remote_page.source.bind_mismatch"), error);
      } else if (error instanceof DesktopApiError && error.code === "remote.source_not_bindable") {
        push_error_toast(t("remote_page.source.bind_not_bindable"), error);
      } else {
        push_error_toast(t("remote_page.source.bind_failed"), error);
      }
    } finally {
      set_is_bind_busy(false);
    }
  }

  const refresh_workspace = useCallback(async (): Promise<void> => {
    const payload = await api_fetch<{ remote_workspace: RemoteWorkspaceSnapshot }>(
      "/api/remote/workspace/snapshot",
      {},
    );
    set_workspace(payload.remote_workspace);
  }, []);

  const refresh_all = useCallback(async (): Promise<void> => {
    await Promise.all([refresh_auth(), refresh_source(), refresh_workspace()]);
  }, [refresh_auth, refresh_source, refresh_workspace]);

  useEffect(() => {
    void refresh_all().catch((error: unknown) => {
      push_error_toast(t("remote_page.load_failed"), error);
    });
    const event_source = open_event_stream();
    let opened_before = false;
    // 断线重连后补读一次，避免错过重连窗口内的快照。
    const handle_open = (): void => {
      if (!opened_before) {
        opened_before = true;
        return;
      }
      void refresh_all().catch(() => undefined);
    };
    const handle_workspace = (event: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(event.data) as {
          remote_workspace?: RemoteWorkspaceSnapshot;
        };
        if (payload.remote_workspace !== undefined) set_workspace(payload.remote_workspace);
      } catch {
        // 事件损坏时定向补读，界面不依赖下一次事件或用户操作。
        void refresh_workspace().catch(() => undefined);
      }
    };
    const handle_auth = (event: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(event.data) as { auth?: RemoteAuth };
        if (payload.auth !== undefined) apply_auth(payload.auth, true);
      } catch {
        void refresh_auth().catch(() => undefined);
      }
    };
    event_source.addEventListener("open", handle_open);
    event_source.addEventListener("remote_workspace.snapshot_changed", handle_workspace);
    event_source.addEventListener("remote_auth.snapshot_changed", handle_auth);
    return () => {
      event_source.removeEventListener("open", handle_open);
      event_source.removeEventListener("remote_workspace.snapshot_changed", handle_workspace);
      event_source.removeEventListener("remote_auth.snapshot_changed", handle_auth);
      event_source.close();
    };
  }, [apply_auth, refresh_all, refresh_auth, refresh_workspace, t]);

  async function import_token(): Promise<void> {
    if (token_input.trim() === "" || is_auth_busy) return;
    set_is_auth_busy(true);
    try {
      const payload = await api_fetch<{ auth: RemoteAuth }>("/api/remote/auth/import", {
        origin: origin_input.trim(),
        token: token_input,
      });
      apply_auth(payload.auth, false);
      set_token_input("");
      push_toast("success", t("remote_page.auth.imported"));
    } catch (error) {
      push_error_toast(t("remote_page.auth.import_failed"), error);
    } finally {
      set_is_auth_busy(false);
    }
  }

  async function clear_token(all: boolean): Promise<void> {
    if (is_auth_busy) return;
    set_is_auth_busy(true);
    try {
      const payload = await api_fetch<{ auth: RemoteAuth }>(
        "/api/remote/auth/clear",
        all ? {} : { origin: origin_input.trim() },
      );
      apply_auth(payload.auth, false);
    } catch (error) {
      push_error_toast(t("remote_page.auth.clear_failed"), error);
    } finally {
      set_is_auth_busy(false);
    }
  }

  async function toggle_bridge(enabled: boolean): Promise<void> {
    if (is_auth_busy || bridge_pending !== null) return;
    set_bridge_pending(enabled ? "enable" : "disable");
    try {
      const payload = await api_fetch<{ auth: RemoteAuth }>("/api/remote/auth/bridge", {
        enabled,
      });
      apply_auth(payload.auth, false);
      push_toast(
        "success",
        enabled ? t("remote_page.auth.bridge.started") : t("remote_page.auth.bridge.stopped_toast"),
      );
    } catch (error) {
      push_error_toast(t("remote_page.auth.bridge.failed"), error);
    } finally {
      set_bridge_pending(null);
    }
  }

  /** 登录结果由后端终态决定：窗口关闭、超时和不可用都不再提示成功。 */
  function notify_login_result(status: RemoteLoginStatus): void {
    if (status === "succeeded") push_toast("success", t("remote_page.auth.login_succeeded"));
    else if (status === "cancelled") push_toast("info", t("remote_page.auth.login_cancelled"));
    else if (status === "timeout") push_toast("warning", t("remote_page.auth.login_timed_out"));
    else if (status === "unavailable") {
      push_toast("warning", t("remote_page.auth.login_unavailable"));
    }
  }

  /** 内嵌窗口登录：请求在窗口关闭或超时前挂起，期间快照由 SSE 持续推送。 */
  async function start_login(): Promise<void> {
    if (is_auth_busy || login_running) return;
    set_is_login_busy(true);
    try {
      const payload = await api_fetch<{ auth: RemoteAuth }>("/api/remote/auth/login", {
        origin: origin_input.trim(),
        theme: resolved_theme,
      });
      apply_auth(payload.auth, false);
      notify_login_result(payload.auth.login.status);
    } catch (error) {
      push_error_toast(t("remote_page.auth.login_failed"), error);
    } finally {
      set_is_login_busy(false);
    }
  }

  /** 取消只结束登录窗口；终态提示由挂起的登录请求统一给出。 */
  async function cancel_login(): Promise<void> {
    try {
      const payload = await api_fetch<{ auth: RemoteAuth }>("/api/remote/auth/login/cancel", {});
      apply_auth(payload.auth, false);
    } catch (error) {
      push_error_toast(t("remote_page.auth.login_failed"), error);
    }
  }

  async function preview_sync(): Promise<void> {
    if (is_sync_busy) return;
    set_is_sync_busy(true);
    try {
      const payload = await api_fetch<{ preview: RemoteSyncPreview }>(
        "/api/remote/novel/sync/preview",
        {},
      );
      set_preview(payload.preview);
      set_align(null);
      set_overrides(new Map());
    } catch (error) {
      push_error_toast(t("remote_page.source.preview_failed"), error);
    } finally {
      set_is_sync_busy(false);
    }
  }

  async function open_align(chapter_index: number): Promise<void> {
    if (preview === null) return;
    try {
      const payload = await api_fetch<{ preview: RemoteAlignPreview }>(
        "/api/remote/novel/align/preview",
        { stash_id: preview.stash_id, chapter_index },
      );
      set_align(payload.preview);
    } catch (error) {
      push_error_toast(t("remote_page.source.preview_failed"), error);
    }
  }

  function set_row_decision(row: RemoteAlignRow, action: "keep" | "retranslate"): void {
    set_overrides((current) => {
      const next = new Map(current);
      next.set(row.row, { action, src_hash: row.src_hash });
      return next;
    });
  }

  async function apply_sync(): Promise<void> {
    if (preview === null || is_sync_busy) return;
    set_is_sync_busy(true);
    try {
      const payload = await api_fetch<{
        result: { skipped_chapters: string[] };
      }>("/api/remote/novel/sync", {
        mode: sync_mode,
        stash_id: preview.stash_id,
        overrides: [...overrides.entries()].map(([row, override]) => ({
          row,
          src_hash: override.src_hash,
          action: override.action,
        })),
      });
      push_toast(
        "success",
        t("remote_page.source.applied").replace(
          "{SKIPPED}",
          String(payload.result.skipped_chapters.length),
        ),
      );
      set_preview(null);
      set_align(null);
      set_overrides(new Map());
      await Promise.all([refresh_source(), refresh_workspace()]);
    } catch (error) {
      push_error_toast(t("remote_page.source.apply_failed"), error);
    } finally {
      set_is_sync_busy(false);
    }
  }

  /** 只上传工程已完成的本地译文；逐章进度由 SSE 快照推进。 */
  async function start_workspace(): Promise<void> {
    if (workspace_running || is_workspace_starting) return;
    set_is_workspace_starting(true);
    try {
      const payload = await api_fetch<{ remote_workspace: RemoteWorkspaceSnapshot }>(
        "/api/remote/workspace/start",
        {},
      );
      set_workspace(payload.remote_workspace);
    } catch (error) {
      push_error_toast(t("remote_page.workspace.start_failed"), error);
    } finally {
      set_is_workspace_starting(false);
    }
  }

  async function cancel_workspace(): Promise<void> {
    if (is_workspace_cancelling) return;
    set_is_workspace_cancelling(true);
    try {
      const payload = await api_fetch<{ remote_workspace: RemoteWorkspaceSnapshot }>(
        "/api/remote/workspace/cancel",
        {},
      );
      set_workspace(payload.remote_workspace);
    } catch (error) {
      push_error_toast(t("remote_page.workspace.cancel_failed"), error);
    } finally {
      set_is_workspace_cancelling(false);
    }
  }

  const active_credential =
    auth?.origins.find((credential) => credential.origin === origin_input.trim()) ?? null;
  const workspace_totals = workspace?.totals ?? {
    chapters: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
  };
  const workspace_processed =
    workspace_totals.uploaded + workspace_totals.skipped + workspace_totals.failed;
  const workspace_completion =
    workspace_totals.chapters === 0 ? 0 : (workspace_processed / workspace_totals.chapters) * 100;
  const workspace_preparing = workspace_running === true && workspace_totals.chapters === 0;

  return (
    <div className="remote-page page-shell">
      <header className="remote-page__header">
        <h1 className="remote-page__title">{t("remote_page.title")}</h1>
        <p className="remote-page__subtitle">{t("remote_page.subtitle")}</p>
      </header>

      <Card variant="panel">
        <CardHeader>
          <CardTitle>{t("remote_page.auth.title")}</CardTitle>
          <CardDescription>{t("remote_page.auth.description")}</CardDescription>
        </CardHeader>
        <CardContent className="remote-page__stack">
          <div className="remote-page__row">
            <Input
              value={origin_input}
              aria-label={t("remote_page.auth.origin")}
              placeholder={auth?.default_origin ?? "https://n.novelia.cc"}
              onChange={(event) => set_origin_input(event.target.value)}
            />
            <Badge
              tone={
                auth === null
                  ? "neutral"
                  : auth.bridge.status.running
                    ? "success"
                    : auth.bridge.enabled
                      ? "warning"
                      : "neutral"
              }
            >
              {auth === null
                ? t("remote_page.auth.bridge.loading")
                : auth.bridge.status.running
                  ? t("remote_page.auth.bridge.running")
                  : auth.bridge.enabled
                    ? t("remote_page.auth.bridge.failed_status")
                    : t("remote_page.auth.bridge.stopped")}
            </Badge>
            <AppButton
              type="button"
              variant="outline"
              size="sm"
              disabled={is_auth_busy || bridge_pending !== null || auth === null}
              onClick={() => {
                void toggle_bridge(auth?.bridge.enabled === false);
              }}
            >
              {bridge_pending === null ? null : <Spinner data-icon="inline-start" />}
              {auth?.bridge.enabled === false
                ? t("remote_page.auth.bridge.enable")
                : t("remote_page.auth.bridge.disable")}
            </AppButton>
          </div>
          <p className="remote-page__hint">
            {auth === null
              ? t("remote_page.auth.bridge.loading")
              : bridge_pending === "enable"
                ? t("remote_page.auth.bridge.enabling")
                : bridge_pending === "disable"
                  ? t("remote_page.auth.bridge.disabling")
                  : auth.bridge.status.running
                    ? (auth.bridge.status.address ?? t("remote_page.auth.bridge.stopped_hint"))
                    : auth.bridge.enabled
                      ? `${t("remote_page.auth.bridge.failed_status")}${auth.bridge.status.error === null ? "" : ` · ${auth.bridge.status.error}`}`
                      : t("remote_page.auth.bridge.stopped_hint")}
          </p>

          <div className="remote-page__actions">
            <AppButton
              type="button"
              disabled={is_auth_busy || login_running}
              onClick={() => {
                void start_login();
              }}
            >
              {login_running ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <LogIn data-icon="inline-start" />
              )}
              {t("remote_page.auth.login")}
            </AppButton>
            <Badge
              tone={
                active_credential === null
                  ? "neutral"
                  : active_credential.expired
                    ? "warning"
                    : "success"
              }
            >
              {active_credential === null
                ? t("remote_page.auth.logged_out")
                : active_credential.expired
                  ? t("remote_page.auth.expired")
                  : t("remote_page.auth.logged_in")}
            </Badge>
            {login_running ? (
              <AppButton
                type="button"
                variant="outline"
                onClick={() => {
                  void cancel_login();
                }}
              >
                <X data-icon="inline-start" />
                {t("remote_page.auth.login_cancel")}
              </AppButton>
            ) : null}
          </div>
          {login_running ? (
            <p className="remote-page__hint">{t("remote_page.auth.login_running")}</p>
          ) : null}

          <Textarea
            value={token_input}
            aria-label={t("remote_page.auth.token")}
            placeholder={t("remote_page.auth.token_placeholder")}
            rows={3}
            onChange={(event) => set_token_input(event.target.value)}
          />
          <div className="remote-page__actions">
            <AppButton
              type="button"
              disabled={is_auth_busy || token_input.trim() === ""}
              onClick={() => {
                void import_token();
              }}
            >
              <ShieldCheck data-icon="inline-start" />
              {t("remote_page.auth.import")}
            </AppButton>
            <AppButton
              type="button"
              variant="outline"
              disabled={is_auth_busy}
              onClick={() => {
                void clear_token(false);
              }}
            >
              <Unlink data-icon="inline-start" />
              {t("remote_page.auth.clear")}
            </AppButton>
            <AppButton
              type="button"
              variant="ghost"
              disabled={is_auth_busy}
              onClick={() => {
                void clear_token(true);
              }}
            >
              {t("remote_page.auth.clear_all")}
            </AppButton>
          </div>

          {auth === null || auth.origins.length === 0 ? (
            <p className="remote-page__hint">{t("remote_page.auth.empty")}</p>
          ) : (
            <ul className="remote-page__list">
              {auth.origins.map((credential) => (
                <li key={credential.origin} className="remote-page__credential">
                  <span className="remote-page__credential-origin">{credential.origin}</span>
                  <span className="remote-page__credential-meta">
                    {t("remote_page.auth.token_tail").replace("{TAIL}", credential.token_tail)}
                    {" · "}
                    {t(
                      credential.source === "bridge"
                        ? "remote_page.auth.source.bridge"
                        : credential.source === "login"
                          ? "remote_page.auth.source.login"
                          : "remote_page.auth.source.manual",
                    )}
                    {" · "}
                    {format_local_timestamp(credential.updated_at) ?? credential.updated_at}
                    {credential.expired ? ` · ${t("remote_page.auth.expired")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card variant="panel">
        <CardHeader>
          <CardTitle>{t("remote_page.source.title")}</CardTitle>
          <CardDescription>{t("remote_page.source.description")}</CardDescription>
        </CardHeader>
        <CardContent className="remote-page__stack">
          {source === null ? (
            <p className="remote-page__hint">{t("remote_page.source.unbound")}</p>
          ) : source.binding === null ? (
            <div className="remote-page__bind">
              <p className="remote-page__hint">{t("remote_page.source.unbound")}</p>
              <p className="remote-page__hint">{t("remote_page.source.bind_hint")}</p>
              <div className="remote-page__url-row">
                <Input
                  value={bind_url}
                  aria-label={t("remote_page.source.bind_url_placeholder")}
                  placeholder={t("remote_page.source.bind_url_placeholder")}
                  disabled={is_bind_busy}
                  onChange={(event) => set_bind_url(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void bind_source();
                    }
                  }}
                />
                <AppButton
                  type="button"
                  disabled={is_bind_busy || bind_url.trim() === ""}
                  onClick={() => {
                    void bind_source();
                  }}
                >
                  {is_bind_busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Link2 data-icon="inline-start" />
                  )}
                  {t(is_bind_busy ? "remote_page.source.binding" : "remote_page.source.bind")}
                </AppButton>
              </div>
            </div>
          ) : (
            <>
              <dl className="remote-page__facts">
                <div>
                  <dt>{t("remote_page.source.novel")}</dt>
                  <dd>{source.binding.title}</dd>
                </div>
                <div>
                  <dt>{t("remote_page.source.url")}</dt>
                  <dd className="remote-page__break">{source.binding.url}</dd>
                </div>
                <div>
                  <dt>{t("remote_page.source.asset")}</dt>
                  <dd>{source.binding.asset_path}</dd>
                </div>
                <div>
                  <dt>{t("remote_page.source.chapters")}</dt>
                  <dd>{source.binding.chapter_count}</dd>
                </div>
                <div>
                  <dt>{t("remote_page.source.last_synced")}</dt>
                  <dd>{format_local_timestamp(source.binding.synced_at) ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("remote_page.source.snapshot")}</dt>
                  <dd>
                    {source.snapshot_present
                      ? t("remote_page.source.snapshot_present")
                      : t("remote_page.source.snapshot_missing")}
                  </dd>
                </div>
              </dl>
              <div className="remote-page__actions">
                <AppButton
                  type="button"
                  disabled={is_sync_busy}
                  onClick={() => {
                    void preview_sync();
                  }}
                >
                  {is_sync_busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RefreshCw data-icon="inline-start" />
                  )}
                  {t("remote_page.source.preview")}
                </AppButton>
              </div>
            </>
          )}

          {preview === null ? null : (
            <section className="remote-page__section">
              {preview.current_asset_changed ? (
                <p className="remote-page__warning">{t("remote_page.source.stale_asset")}</p>
              ) : null}
              {preview.snapshot_available ? null : (
                <p className="remote-page__warning">{t("remote_page.source.no_snapshot")}</p>
              )}
              <div className="remote-page__stats">
                {(
                  [
                    ["added", preview.stats.added],
                    ["modified", preview.stats.modified],
                    ["removed", preview.stats.removed],
                    ["inherited", preview.stats.inherited],
                    ["remote_inherited", preview.stats.remote_inherited],
                    ["would_lose", preview.stats.would_lose],
                  ] as const
                ).map(([key, value]) => (
                  <span key={key} className="remote-page__stat">
                    {t(`remote_page.source.stats.${key}`)}: <strong>{value}</strong>
                  </span>
                ))}
              </div>
              {preview.stats.requires_alignment ? (
                <p className="remote-page__warning">{t("remote_page.source.alignment_required")}</p>
              ) : null}

              <ul className="remote-page__chapters">
                {preview.chapters.map((chapter) => (
                  <li key={`${chapter.index}-${chapter.old_index ?? "new"}`}>
                    <button
                      type="button"
                      className="remote-page__chapter"
                      onClick={() => {
                        void open_align(chapter.index);
                      }}
                    >
                      <span className="remote-page__chapter-title">
                        {chapter.title === "" ? t("remote_page.source.preamble") : chapter.title}
                      </span>
                      <Badge tone={chapter_status_tone(chapter.status)}>
                        {t(`remote_page.source.chapter_status.${chapter.status}`)}
                      </Badge>
                      <span className="remote-page__chapter-meta">
                        +{chapter.added} · ~{chapter.modified} · -{chapter.removed} · !
                        {chapter.would_lose}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <SegmentedToggle<SyncMode>
                aria_label={t("remote_page.source.mode.label")}
                value={sync_mode}
                options={[
                  { value: "add_only", label: t("remote_page.source.mode.add_only") },
                  { value: "auto", label: t("remote_page.source.mode.auto") },
                  { value: "manual", label: t("remote_page.source.mode.manual") },
                ]}
                on_value_change={set_sync_mode}
              />
              <p className="remote-page__hint">{t(`remote_page.source.mode.${sync_mode}_hint`)}</p>
              <div className="remote-page__actions">
                <AppButton
                  type="button"
                  disabled={
                    is_sync_busy || (sync_mode === "auto" && preview.stats.requires_alignment)
                  }
                  onClick={() => {
                    void apply_sync();
                  }}
                >
                  {is_sync_busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <CloudDownload data-icon="inline-start" />
                  )}
                  {t("remote_page.source.apply")}
                </AppButton>
              </div>

              {align === null ? null : (
                <section className="remote-page__align">
                  <h3 className="remote-page__section-title">
                    {align.chapter.title === ""
                      ? t("remote_page.source.preamble")
                      : align.chapter.title}
                  </h3>
                  <ul className="remote-page__rows">
                    {align.rows.map((row) => {
                      const override = overrides.get(row.row);
                      const decision = override?.action ?? row.decision;
                      const has_old_dst = row.old_dst !== null;
                      const remote_dst_allowed =
                        (row.old_dst === null || row.old_dst === "") &&
                        !(
                          row.old_status !== null &&
                          REMOTE_TRANSLATION_BLOCKED_STATUSES.has(row.old_status)
                        );
                      const candidate_remote_dst = remote_dst_allowed ? row.remote_dst : null;
                      const remote_dst =
                        typeof candidate_remote_dst === "string" && candidate_remote_dst !== ""
                          ? candidate_remote_dst
                          : null;
                      const has_remote_dst = remote_dst !== null;
                      const uses_remote = override === undefined && has_remote_dst;
                      return (
                        <li key={row.row} className="remote-page__row-item">
                          <div className="remote-page__row-text">
                            <p>{row.src}</p>
                            {row.old_src === null || row.old_src === row.src ? null : (
                              <p className="remote-page__row-old">{row.old_src}</p>
                            )}
                            {row.old_dst === null || row.old_dst === "" ? null : (
                              <p className="remote-page__row-dst">{row.old_dst}</p>
                            )}
                            {has_remote_dst ? (
                              <p className="remote-page__row-dst">
                                <span className="remote-page__row-label">
                                  {t("remote_page.source.remote_dst")}
                                </span>
                                {remote_dst}
                              </p>
                            ) : null}
                          </div>
                          {has_old_dst || has_remote_dst ? (
                            <div className="remote-page__row-actions">
                              {has_old_dst ? (
                                <AppButton
                                  type="button"
                                  size="xs"
                                  variant={decision === "keep" ? "default" : "outline"}
                                  onClick={() => set_row_decision(row, "keep")}
                                >
                                  {t("remote_page.source.keep")}
                                </AppButton>
                              ) : null}
                              <AppButton
                                type="button"
                                size="xs"
                                variant={
                                  decision === "retranslate" && !uses_remote ? "default" : "outline"
                                }
                                onClick={() => set_row_decision(row, "retranslate")}
                              >
                                {t("remote_page.source.retranslate")}
                              </AppButton>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </section>
          )}
        </CardContent>
      </Card>

      <Card variant="panel">
        <CardHeader>
          <CardTitle>{t("remote_page.workspace.title")}</CardTitle>
          <CardDescription>{t("remote_page.workspace.description")}</CardDescription>
        </CardHeader>
        <CardContent className="remote-page__stack">
          <div className="remote-page__actions">
            <AppButton
              type="button"
              disabled={
                workspace_running ||
                is_workspace_starting ||
                source === null ||
                source.binding === null
              }
              onClick={() => {
                void start_workspace();
              }}
            >
              {is_workspace_starting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Send data-icon="inline-start" />
              )}
              {t("remote_page.workspace.start")}
            </AppButton>
            {workspace_running || is_workspace_cancelling ? (
              <AppButton
                type="button"
                variant="outline"
                disabled={is_workspace_cancelling}
                onClick={() => {
                  void cancel_workspace();
                }}
              >
                {is_workspace_cancelling ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <X data-icon="inline-start" />
                )}
                {t("remote_page.workspace.cancel")}
              </AppButton>
            ) : null}
          </div>
          <p className="remote-page__hint">{t("remote_page.workspace.cancel_hint")}</p>

          {workspace === null ? null : (
            <>
              <div className="remote-page__stats">
                <span className="remote-page__stat">
                  {t("remote_page.workspace.status_label")}:{" "}
                  <strong>{t(`remote_page.workspace.status.${workspace.status}`)}</strong>
                </span>
                <span className="remote-page__stat">
                  {t("remote_page.workspace.uploaded")}:{" "}
                  <strong>{workspace.totals.uploaded}</strong>
                </span>
                <span className="remote-page__stat">
                  {t("remote_page.workspace.skipped")}: <strong>{workspace.totals.skipped}</strong>
                </span>
                <span className="remote-page__stat">
                  {t("remote_page.workspace.failed")}: <strong>{workspace.totals.failed}</strong>
                </span>
              </div>

              {workspace_preparing ? (
                <p className="remote-page__hint">
                  <Spinner data-icon="inline-start" />
                  {t("remote_page.workspace.preparing")}
                </p>
              ) : workspace.totals.chapters === 0 ? null : (
                <div className="remote-page__progress">
                  <div className="remote-page__progress-head">
                    <span>
                      {t("remote_page.workspace.progress")
                        .replace("{DONE}", String(workspace_processed))
                        .replace("{TOTAL}", String(workspace.totals.chapters))}
                    </span>
                    <span>{workspace_completion.toFixed(0)}%</span>
                  </div>
                  <SegmentedProgress
                    stats={{
                      total_items: workspace.totals.chapters,
                      completed_count: workspace.totals.uploaded,
                      failed_count: workspace.totals.failed,
                      pending_count: Math.max(workspace.totals.chapters - workspace_processed, 0),
                      skipped_count: workspace.totals.skipped,
                      completion_percent: workspace_completion,
                    }}
                    labels={{
                      skipped: t("remote_page.workspace.skipped"),
                      failed: t("remote_page.workspace.failed"),
                      completed: t("remote_page.workspace.uploaded"),
                      pending: t("remote_page.workspace.chapter_state.pending"),
                      total: t("remote_page.workspace.total"),
                    }}
                  />
                </div>
              )}

              {workspace.status === "failed" && workspace.error !== null ? (
                <p className="remote-page__warning">
                  {t("remote_page.workspace.error_hint").replace("{ERROR}", workspace.error)}
                </p>
              ) : null}
              <ul className="remote-page__chapters">
                {workspace.chapters.map((chapter) => (
                  <li key={chapter.chapter_id} className="remote-page__workspace-chapter">
                    <span className="remote-page__chapter-title">
                      {chapter.title === "" ? chapter.chapter_id : chapter.title}
                    </span>
                    {chapter.state === "reading" || chapter.state === "uploading" ? (
                      <Spinner />
                    ) : null}
                    <Badge
                      tone={
                        chapter.state === "uploaded"
                          ? "success"
                          : chapter.state === "failed"
                            ? "failure"
                            : chapter.state === "skipped"
                              ? "warning"
                              : "neutral"
                      }
                    >
                      {t(`remote_page.workspace.chapter_state.${chapter.state}`)}
                    </Badge>
                    <span className="remote-page__chapter-meta">
                      {t("remote_page.workspace.ready").replace("{READY}", String(chapter.ready))}
                      {chapter.missing > 0
                        ? ` · ${t("remote_page.workspace.missing").replace(
                            "{MISSING}",
                            String(chapter.missing),
                          )}`
                        : ""}
                      {chapter.message === null
                        ? ""
                        : ` · ${
                            chapter.message === "local_translation_incomplete" ||
                            chapter.message === "identical_to_remote_translation" ||
                            chapter.message === "local_chapter_mismatch"
                              ? t(`remote_page.workspace.chapter_message.${chapter.message}`)
                              : t("remote_page.workspace.chapter_error").replace(
                                  "{ERROR}",
                                  chapter.message,
                                )
                          }`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function chapter_status_tone(
  status: RemoteChapterPlan["status"],
): "success" | "warning" | "failure" | "neutral" {
  if (status === "unchanged") return "success";
  if (status === "modified" || status === "ambiguous") return "warning";
  if (status === "removed") return "failure";
  return "neutral";
}
