import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "@frontend/app/locale/locale-provider";
import { ProjectSwitcher } from "@frontend/app/shell/project-switcher";

const { api_fetch_mock, push_toast_mock } = vi.hoisted(() => {
  return {
    api_fetch_mock: vi.fn(),
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
  };
});

vi.mock("@frontend/app/feedback/desktop-toast", () => ({
  push_error_toast: push_toast_mock,
}));

const OTHER_INSTANCE = {
  pid: 777,
  api_base_url: "http://127.0.0.1:4568",
  app_version: "1.0.0",
  project_path: "E:/projects/running.lg",
  started_at: "2026-10-21T00:00:00.000Z",
  heartbeat_at: "2026-10-21T00:00:10.000Z",
  current: false,
};

describe("ProjectSwitcher", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/app/instances") return { instances: [OTHER_INSTANCE] };
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
    push_toast_mock.mockReset();
  });

  async function mount_switcher(args: {
    current_project_path: string;
    recent_projects: Array<{ path: string; name: string }>;
    on_open_in_current_window: (project_path: string) => Promise<void>;
  }): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocaleProvider locale="zh-CN">
          <ProjectSwitcher
            current_project_path={args.current_project_path}
            recent_projects={args.recent_projects}
            on_open_in_current_window={args.on_open_in_current_window}
          />
        </LocaleProvider>,
      );
    });
  }

  /** 打开菜单后等待实例清单与 portal 内容落稳。 */
  async function open_menu(): Promise<void> {
    const trigger = container?.querySelector<HTMLButtonElement>(".topbar__project-trigger");
    if (trigger === null || trigger === undefined) throw new Error("缺少工程切换按钮。");
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function find_menu_item(text: string): HTMLElement {
    const item = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]'),
    ).find((element) => element.textContent?.includes(text) ?? false);
    if (item === undefined) throw new Error(`未找到菜单项：${text}`);
    return item;
  }

  it("展示当前工程并聚焦其他运行窗口", async () => {
    await mount_switcher({
      current_project_path: "E:/projects/demo.lg",
      recent_projects: [],
      on_open_in_current_window: vi.fn(async () => {}),
    });

    expect(container?.textContent).toContain("demo");

    await open_menu();

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/app/instances", {});
    expect(document.body.textContent).toContain("running");

    await act(async () => {
      find_menu_item("running").click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/app/instances/focus", { pid: 777 });
  });

  it("最近工程可在当前窗口或新窗口打开", async () => {
    const on_open_in_current_window = vi.fn(async () => {});
    await mount_switcher({
      current_project_path: "",
      recent_projects: [{ path: "E:/projects/other.lg", name: "other" }],
      on_open_in_current_window,
    });

    await open_menu();
    const submenu_trigger = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]'),
    ).find((element) => element.textContent?.includes("other") ?? false);
    if (submenu_trigger === undefined) throw new Error("未找到最近工程子菜单。");

    await act(async () => {
      submenu_trigger.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      find_menu_item("在当前窗口打开").click();
    });
    expect(on_open_in_current_window).toHaveBeenCalledWith("E:/projects/other.lg");

    await open_menu();
    const reopened_trigger = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]'),
    ).find((element) => element.textContent?.includes("other") ?? false);
    if (reopened_trigger === undefined) throw new Error("未找到最近工程子菜单。");
    await act(async () => {
      reopened_trigger.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      find_menu_item("在新窗口打开").click();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/app/instances/open", {
      path: "E:/projects/other.lg",
    });
  });
});
