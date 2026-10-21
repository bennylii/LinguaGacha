import { type JSX, useCallback, useEffect, useState } from "react";
import { CloudDownload, RefreshCw, Send, ShieldCheck, Unlink } from "lucide-react";

import { api_fetch, open_event_stream } from "@frontend/app/desktop/desktop-api";
import { push_error_toast, push_toast } from "@frontend/app/feedback/desktop-toast";
import { useI18n } from "@frontend/app/locale/locale-context";
import { Badge } from "@frontend/shadcn/badge";
import { Input } from "@frontend/shadcn/input";
import { Spinner } from "@frontend/shadcn/spinner";
import { Textarea } from "@frontend/shadcn/textarea";
import { SegmentedToggle } from "@frontend/shadcn/segmented-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@frontend/shadcn/card";
import { AppButton } from "@frontend/widgets/app-button";
import { format_local_timestamp } from "@shared/utils/format-local-timestamp";
import "@frontend/pages/remote-page/remote-page.css";

type RemoteCredential = {
  origin: string;
  token_tail: string;
  updated_at: string;
  source: "bridge" | "manual";
};

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
};

type RemoteAlignPreview = {
  stash_id: string;
  chapter: RemoteChapterPlan;
  rows: RemoteAlignRow[];
};

type RemoteWorkspaceChapter = {
  chapter_id: string;
  title: string;
  state: "pending" | "working" | "uploaded" | "skipped" | "failed";
  existing: number;
  translated: number;
  missing: number;
  message: string | null;
};

type RemoteWorkspaceSnapshot = {
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  mode: "missing" | "all" | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  totals: {
    chapters: number;
    uploaded: number;
    skipped: number;
    failed: number;
    existing: number;
    translated: number;
  };
  chapters: RemoteWorkspaceChapter[];
};

type SyncMode = "add_only" | "auto" | "manual";
type WorkspaceMode = "missing" | "all";

type RowOverride = { action: "keep" | "retranslate"; src_hash: string };

/**
 * 远程小说页：站点凭据、工程绑定与同步、工作区提交集中在一个入口。
 * 页面只消费 API 事实；预览暂存在后端内存，应用时必须携带同一 stash。
 */
export function RemotePage(): JSX.Element {
  const { t } = useI18n();
  const [auth, set_auth] = useState<RemoteAuth | null>(null);
  const [source, set_source] = useState<RemoteSource | null>(null);
  const [workspace, set_workspace] = useState<RemoteWorkspaceSnapshot | null>(null);
  const [token_input, set_token_input] = useState("");
  const [origin_input, set_origin_input] = useState("");
  const [is_auth_busy, set_is_auth_busy] = useState(false);
  const [preview, set_preview] = useState<RemoteSyncPreview | null>(null);
  const [align, set_align] = useState<RemoteAlignPreview | null>(null);
  const [overrides, set_overrides] = useState<Map<number, RowOverride>>(() => new Map());
  const [sync_mode, set_sync_mode] = useState<SyncMode>("auto");
  const [is_sync_busy, set_is_sync_busy] = useState(false);
  const [is_workspace_busy, set_is_workspace_busy] = useState(false);

  const refresh_auth = useCallback(async (): Promise<void> => {
    const payload = await api_fetch<{ auth: RemoteAuth }>("/api/remote/auth/status", {});
    set_auth(payload.auth);
    set_origin_input((current) => (current === "" ? payload.auth.default_origin : current));
  }, []);

  const refresh_source = useCallback(async (): Promise<void> => {
    const payload = await api_fetch<{ source: RemoteSource }>("/api/remote/source/read", {});
    set_source(payload.source);
  }, []);

  const refresh_workspace = useCallback(async (): Promise<void> => {
    const payload = await api_fetch<{ remote_workspace: RemoteWorkspaceSnapshot }>(
      "/api/remote/workspace/snapshot",
      {},
    );
    set_workspace(payload.remote_workspace);
    set_is_workspace_busy(payload.remote_workspace.status === "running");
  }, []);

  const refresh_all = useCallback(async (): Promise<void> => {
    await Promise.all([refresh_auth(), refresh_source(), refresh_workspace()]);
  }, [refresh_auth, refresh_source, refresh_workspace]);

  useEffect(() => {
    void refresh_all().catch((error: unknown) => {
      push_error_toast(t("remote_page.load_failed"), error);
    });
    const event_source = open_event_stream();
    const handle_workspace = (event: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(event.data) as {
          remote_workspace?: RemoteWorkspaceSnapshot;
        };
        if (payload.remote_workspace !== undefined) {
          set_workspace(payload.remote_workspace);
          set_is_workspace_busy(payload.remote_workspace.status === "running");
        }
      } catch {
        // 事件损坏时保持当前快照，下一次轮询或操作会重新读取。
      }
    };
    event_source.addEventListener("remote_workspace.snapshot_changed", handle_workspace);
    return () => {
      event_source.removeEventListener("remote_workspace.snapshot_changed", handle_workspace);
      event_source.close();
    };
  }, [refresh_all, t]);

  async function import_token(): Promise<void> {
    if (token_input.trim() === "" || is_auth_busy) return;
    set_is_auth_busy(true);
    try {
      const payload = await api_fetch<{ auth: RemoteAuth }>("/api/remote/auth/import", {
        origin: origin_input.trim(),
        token: token_input,
      });
      set_auth(payload.auth);
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
      set_auth(payload.auth);
    } catch (error) {
      push_error_toast(t("remote_page.auth.clear_failed"), error);
    } finally {
      set_is_auth_busy(false);
    }
  }

  async function toggle_bridge(enabled: boolean): Promise<void> {
    if (is_auth_busy) return;
    set_is_auth_busy(true);
    try {
      const payload = await api_fetch<{ auth: RemoteAuth }>("/api/remote/auth/bridge", {
        enabled,
      });
      set_auth(payload.auth);
    } catch (error) {
      push_error_toast(t("remote_page.auth.bridge.failed"), error);
    } finally {
      set_is_auth_busy(false);
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

  async function start_workspace(mode: WorkspaceMode): Promise<void> {
    if (is_workspace_busy) return;
    set_is_workspace_busy(true);
    try {
      const payload = await api_fetch<{ remote_workspace: RemoteWorkspaceSnapshot }>(
        "/api/remote/workspace/start",
        { mode },
      );
      set_workspace(payload.remote_workspace);
    } catch (error) {
      set_is_workspace_busy(false);
      push_error_toast(t("remote_page.workspace.start_failed"), error);
    }
  }

  async function cancel_workspace(): Promise<void> {
    try {
      const payload = await api_fetch<{ remote_workspace: RemoteWorkspaceSnapshot }>(
        "/api/remote/workspace/cancel",
        {},
      );
      set_workspace(payload.remote_workspace);
      set_is_workspace_busy(false);
    } catch (error) {
      push_error_toast(t("remote_page.workspace.start_failed"), error);
    }
  }

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
            <Badge tone={auth?.bridge.status.running ? "success" : "neutral"}>
              {auth?.bridge.status.running
                ? t("remote_page.auth.bridge.running")
                : t("remote_page.auth.bridge.stopped")}
            </Badge>
            <AppButton
              type="button"
              variant="outline"
              size="sm"
              disabled={is_auth_busy}
              onClick={() => {
                void toggle_bridge(auth?.bridge.enabled === false);
              }}
            >
              {auth?.bridge.enabled === false
                ? t("remote_page.auth.bridge.enable")
                : t("remote_page.auth.bridge.disable")}
            </AppButton>
          </div>
          <p className="remote-page__hint">
            {auth?.bridge.status.address ?? t("remote_page.auth.bridge.stopped_hint")}
            {auth?.bridge.status.error ? ` · ${auth.bridge.status.error}` : ""}
          </p>

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
                        : "remote_page.auth.source.manual",
                    )}
                    {" · "}
                    {format_local_timestamp(credential.updated_at) ?? credential.updated_at}
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
          {source?.binding === null || source === null ? (
            <p className="remote-page__hint">{t("remote_page.source.unbound")}</p>
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
                          </div>
                          {row.old_dst === null ? null : (
                            <div className="remote-page__row-actions">
                              <AppButton
                                type="button"
                                size="xs"
                                variant={decision === "keep" ? "default" : "outline"}
                                onClick={() => set_row_decision(row, "keep")}
                              >
                                {t("remote_page.source.keep")}
                              </AppButton>
                              <AppButton
                                type="button"
                                size="xs"
                                variant={decision === "retranslate" ? "default" : "outline"}
                                onClick={() => set_row_decision(row, "retranslate")}
                              >
                                {t("remote_page.source.retranslate")}
                              </AppButton>
                            </div>
                          )}
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
              disabled={is_workspace_busy || source?.binding === null}
              onClick={() => {
                void start_workspace("missing");
              }}
            >
              <Send data-icon="inline-start" />
              {t("remote_page.workspace.start_missing")}
            </AppButton>
            <AppButton
              type="button"
              variant="outline"
              disabled={is_workspace_busy || source?.binding === null}
              onClick={() => {
                void start_workspace("all");
              }}
            >
              {t("remote_page.workspace.start_all")}
            </AppButton>
            <AppButton
              type="button"
              variant="ghost"
              disabled={workspace?.status !== "running"}
              onClick={() => {
                void cancel_workspace();
              }}
            >
              {t("remote_page.workspace.cancel")}
            </AppButton>
          </div>

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
              {workspace.error === null ? null : (
                <p className="remote-page__warning">{workspace.error}</p>
              )}
              <ul className="remote-page__chapters">
                {workspace.chapters.map((chapter) => (
                  <li key={chapter.chapter_id} className="remote-page__workspace-chapter">
                    <span className="remote-page__chapter-title">
                      {chapter.title === "" ? chapter.chapter_id : chapter.title}
                    </span>
                    <Badge
                      tone={
                        chapter.state === "uploaded"
                          ? "success"
                          : chapter.state === "failed"
                            ? "failure"
                            : "neutral"
                      }
                    >
                      {t(`remote_page.workspace.chapter_state.${chapter.state}`)}
                    </Badge>
                    <span className="remote-page__chapter-meta">
                      {t("remote_page.workspace.existing").replace(
                        "{COUNT}",
                        String(chapter.existing),
                      )}
                      {" · "}
                      {t("remote_page.workspace.translated").replace(
                        "{COUNT}",
                        String(chapter.translated),
                      )}
                      {chapter.message === null ? "" : ` · ${chapter.message}`}
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
