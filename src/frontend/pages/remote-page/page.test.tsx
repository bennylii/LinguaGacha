import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "@frontend/app/locale/locale-provider";
import { RemotePage } from "@frontend/pages/remote-page/page";

const { api_fetch_mock, open_event_stream_mock, push_toast_mock } = vi.hoisted(() => {
  return {
    api_fetch_mock: vi.fn(),
    open_event_stream_mock: vi.fn(),
    push_toast_mock: vi.fn(),
  };
});

vi.mock("@frontend/app/desktop/desktop-api", async () => {
  const actual = await vi.importActual<typeof import("@frontend/app/desktop/desktop-api")>(
    "@frontend/app/desktop/desktop-api",
  );
  return {
    ...actual,
    api_fetch: api_fetch_mock,
    open_event_stream: open_event_stream_mock,
  };
});

vi.mock("@frontend/app/feedback/desktop-toast", () => ({
  push_error_toast: push_toast_mock,
  push_toast: push_toast_mock,
}));

vi.mock("@frontend/app/appearance/appearance-context", () => ({
  useAppearance: () => ({ resolved_theme: "light" }),
}));

const AUTH_SNAPSHOT = {
  default_origin: "https://n.novelia.cc",
  origins: [
    {
      origin: "https://n.novelia.cc",
      token_tail: "abcd",
      updated_at: "2026-10-01T10:00:00",
      source: "manual",
      expired: false,
    },
  ],
  bridge: {
    enabled: true,
    status: {
      running: true,
      port: 7331,
      address: "127.0.0.1:7331",
      error: null,
    },
  },
  login: {
    running: false,
    origin: null,
    started_at: null,
  },
};

const SOURCE_SNAPSHOT = {
  binding: {
    origin: "https://n.novelia.cc",
    kind: "web",
    title: "测试小说",
    url: "https://n.novelia.cc/novel/kakuyomu/123456",
    asset_path: "测试小说.txt",
    chapter_count: 12,
    synced_at: "2026-10-01T10:00:00",
  },
  asset_present: true,
  snapshot_present: true,
};

const WORKSPACE_SNAPSHOT = {
  status: "idle",
  mode: null,
  started_at: null,
  finished_at: null,
  error: null,
  totals: {
    chapters: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    existing: 0,
    translated: 0,
  },
  chapters: [],
};

const SYNC_PREVIEW = {
  stash_id: "stash-1",
  created_at: "2026-10-01T10:00:00",
  expires_at: "2026-10-01T10:10:00",
  filename: "测试小说.txt",
  previous_source: "snapshot",
  snapshot_available: true,
  current_asset_changed: false,
  stats: {
    added: 2,
    modified: 1,
    removed: 0,
    inherited: 30,
    remote_inherited: 3,
    would_lose: 1,
    diverged: false,
    requires_alignment: false,
  },
  chapters: [
    {
      index: 1,
      kind: "chapter",
      title: "第一章",
      status: "modified",
      old_index: 1,
      added: 2,
      modified: 1,
      removed: 0,
      inherited: 10,
      would_lose: 1,
    },
  ],
};

/** 受控输入框走原生 setter，让 React 观察到值变化。 */
function set_form_value(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 按用户可见文案读取按钮，缺失时给出可定位错误。 */
function get_button_by_text(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((element) => {
    return element.textContent?.includes(text) ?? false;
  });

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`未找到按钮：${text}`);
  }

  return button;
}

describe("RemotePage", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let event_source: {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    event_source = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
    open_event_stream_mock.mockReturnValue(event_source);
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/remote/auth/status") return { auth: AUTH_SNAPSHOT };
      if (path === "/api/remote/source/read") return { source: SOURCE_SNAPSHOT };
      if (path === "/api/remote/workspace/snapshot") {
        return { remote_workspace: WORKSPACE_SNAPSHOT };
      }

      return {};
    });
  });

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }

    container?.remove();
    container = null;
    root = null;
    api_fetch_mock.mockReset();
    open_event_stream_mock.mockReset();
    push_toast_mock.mockReset();
  });

  /** 使用真实中文 i18n 资源挂载远程页。 */
  async function mount_page(): Promise<HTMLElement> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <LocaleProvider locale="zh-CN">
          <RemotePage />
        </LocaleProvider>,
      );
    });

    return container;
  }

  it("展示绑定与凭据，并完成预览、行级对齐和应用同步", async () => {
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/remote/auth/status") return { auth: AUTH_SNAPSHOT };
      if (path === "/api/remote/source/read") return { source: SOURCE_SNAPSHOT };
      if (path === "/api/remote/workspace/snapshot") {
        return { remote_workspace: WORKSPACE_SNAPSHOT };
      }
      if (path === "/api/remote/novel/sync/preview") return { preview: SYNC_PREVIEW };
      if (path === "/api/remote/novel/align/preview") {
        return {
          preview: {
            stash_id: "stash-1",
            chapter: SYNC_PREVIEW.chapters[0],
            rows: [
              {
                row: 10,
                src: "新的第十行",
                src_hash: "hash-a",
                decision: "retranslate",
                similarity: 0.5,
                review: true,
                old_src: "旧的第十行",
                old_dst: "旧译文",
                old_status: "PROCESSED",
                remote_dst: null,
              },
              {
                row: 11,
                src: "第十一行",
                src_hash: "hash-b",
                decision: "keep",
                similarity: 1,
                review: false,
                old_src: "第十一行",
                old_dst: "第十一行译文",
                old_status: "PROCESSED",
                remote_dst: null,
              },
              {
                row: 12,
                src: "新增的第十二行",
                src_hash: "hash-c",
                decision: "retranslate",
                similarity: 0,
                review: false,
                old_src: null,
                old_dst: null,
                old_status: null,
                remote_dst: "站点第十二行译文",
              },
              {
                row: 13,
                src: "排除的第十三行",
                src_hash: "hash-d",
                decision: "preserve",
                similarity: 1,
                review: false,
                old_src: "排除的第十三行",
                old_dst: "",
                old_status: "EXCLUDED",
                remote_dst: "排除行不应展示的站点译文",
              },
            ],
          },
        };
      }
      if (path === "/api/remote/novel/sync") {
        return { result: { skipped_chapters: [] } };
      }

      return {};
    });

    const page = await mount_page();

    expect(page.textContent).toContain("测试小说");
    expect(page.textContent).toContain("尾号 abcd");
    expect(page.textContent).toContain("127.0.0.1:7331");

    await act(async () => {
      get_button_by_text(page, "预览同步").click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/remote/novel/sync/preview", {});
    expect(page.textContent).toContain("有修改");
    expect(page.textContent).toContain("会丢失译文: 1");
    expect(page.textContent).toContain("站点沿用: 3");

    const chapter_button = page.querySelector<HTMLButtonElement>(".remote-page__chapter");
    if (chapter_button === null) throw new Error("未找到章节行。");
    await act(async () => {
      chapter_button.click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/remote/novel/align/preview", {
      stash_id: "stash-1",
      chapter_index: 1,
    });
    expect(page.textContent).toContain("旧译文");
    expect(page.textContent).toContain("站点译文");
    expect(page.textContent).toContain("站点第十二行译文");
    expect(page.textContent).not.toContain("排除行不应展示的站点译文");

    await act(async () => {
      get_button_by_text(page, "保留旧译").click();
    });
    await act(async () => {
      get_button_by_text(page, "应用同步").click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/remote/novel/sync", {
      mode: "auto",
      stash_id: "stash-1",
      overrides: [{ row: 10, src_hash: "hash-a", action: "keep" }],
    });
    expect(push_toast_mock).toHaveBeenCalledWith("success", expect.stringContaining("同步完成"));
  });

  it("手动导入 token 后展示末位并允许启动工作区提交", async () => {
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/remote/auth/status") return { auth: AUTH_SNAPSHOT };
      if (path === "/api/remote/source/read") return { source: SOURCE_SNAPSHOT };
      if (path === "/api/remote/workspace/snapshot") {
        return { remote_workspace: WORKSPACE_SNAPSHOT };
      }
      if (path === "/api/remote/auth/import") {
        return {
          auth: {
            ...AUTH_SNAPSHOT,
            origins: [
              {
                origin: "https://n.novelia.cc",
                token_tail: "wxyz",
                updated_at: "2026-10-02T11:00:00",
                source: "manual",
              },
            ],
          },
        };
      }
      if (path === "/api/remote/workspace/start") {
        return {
          remote_workspace: {
            ...WORKSPACE_SNAPSHOT,
            status: "running",
            mode: "missing",
          },
        };
      }

      return {};
    });

    const page = await mount_page();
    const token_box = page.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="站点 token 或 Cookie"]',
    );
    if (token_box === null) throw new Error("未找到凭据输入框。");

    await act(async () => {
      set_form_value(token_box, "Bearer abcdefwxyz");
    });
    await act(async () => {
      get_button_by_text(page, "导入凭据").click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/remote/auth/import", {
      origin: "https://n.novelia.cc",
      token: "Bearer abcdefwxyz",
    });
    expect(push_toast_mock).toHaveBeenCalledWith("success", "凭据已保存");
    expect(page.textContent).toContain("尾号 wxyz");

    await act(async () => {
      get_button_by_text(page, "补译缺失并提交").click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/remote/workspace/start", {
      mode: "missing",
    });
    expect(page.textContent).toContain("提交中");
  });

  it("通过内嵌窗口登录并保存登录来源凭据", async () => {
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/remote/auth/status") return { auth: AUTH_SNAPSHOT };
      if (path === "/api/remote/source/read") return { source: SOURCE_SNAPSHOT };
      if (path === "/api/remote/workspace/snapshot") {
        return { remote_workspace: WORKSPACE_SNAPSHOT };
      }
      if (path === "/api/remote/auth/login") {
        return {
          auth: {
            ...AUTH_SNAPSHOT,
            origins: [
              {
                origin: "https://n.novelia.cc",
                token_tail: "log1",
                updated_at: "2026-10-03T12:00:00",
                source: "login",
                expired: false,
              },
            ],
          },
        };
      }

      return {};
    });

    const page = await mount_page();
    await act(async () => {
      get_button_by_text(page, "登录站点").click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/remote/auth/login", {
      origin: "https://n.novelia.cc",
      theme: "light",
    });
    expect(push_toast_mock).toHaveBeenCalledWith("success", "登录成功，凭据已保存");
    expect(page.textContent).toContain("尾号 log1");
  });

  it("登录中状态由事件流推送并可取消", async () => {
    const page = await mount_page();
    const auth_listener = event_source.addEventListener.mock.calls.find(
      (call) => call[0] === "remote_auth.snapshot_changed",
    )?.[1];
    if (typeof auth_listener !== "function") throw new Error("未订阅登录状态事件。");

    await act(async () => {
      auth_listener(
        new MessageEvent("remote_auth.snapshot_changed", {
          data: JSON.stringify({
            auth: {
              ...AUTH_SNAPSHOT,
              login: {
                running: true,
                origin: "https://n.novelia.cc",
                started_at: "2026-10-03T12:00:00",
              },
            },
          }),
        }),
      );
    });

    expect(page.textContent).toContain("登录窗口已打开");

    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/remote/auth/login/cancel") {
        return {
          auth: { ...AUTH_SNAPSHOT, login: { running: false, origin: null, started_at: null } },
        };
      }
      return {};
    });
    await act(async () => {
      get_button_by_text(page, "取消登录").click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/remote/auth/login/cancel", {});
    expect(page.textContent).not.toContain("登录窗口已打开");
  });
});
