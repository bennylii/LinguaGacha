import { type ReactNode, act } from "react";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BasicSettingsPage } from "@frontend/pages/basic-settings-page/page";

const { basic_settings_state_fixture, push_toast_mock } = vi.hoisted(() => {
  return {
    basic_settings_state_fixture: {
      current: null as ReturnType<typeof create_basic_settings_state_fixture> | null,
    },
    push_toast_mock: vi.fn(),
  };
});

vi.mock("@frontend/app/locale/locale-context", () => {
  return {
    useI18n: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock("@frontend/app/feedback/desktop-toast", () => ({
  push_error_toast: push_toast_mock,
  push_toast: push_toast_mock,
}));

vi.mock("@frontend/pages/basic-settings-page/use-basic-settings-state", () => {
  return {
    useBasicSettingsState: () => basic_settings_state_fixture.current,
  };
});

vi.mock("@frontend/widgets/setting-card-row/setting-card-row", () => {
  return {
    SettingCardRow: (props: { title: string; action: ReactNode }) => (
      <section aria-label={props.title}>{props.action}</section>
    ),
  };
});

vi.mock("@frontend/widgets/boolean-segmented-toggle", () => {
  return {
    BooleanSegmentedToggle: () => <button type="button" />,
  };
});

vi.mock("@frontend/shadcn/select", () => {
  return {
    Select: (props: { children: ReactNode }) => <div>{props.children}</div>,
    SelectContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
    SelectGroup: (props: { children: ReactNode }) => <div>{props.children}</div>,
    SelectItem: (props: { children: ReactNode; value: string }) => (
      <div data-value={props.value}>{props.children}</div>
    ),
    SelectTrigger: (props: { children: ReactNode }) => (
      <button type="button">{props.children}</button>
    ),
    SelectValue: () => <span />,
  };
});

/** 隔离页面输入行为，保存结果由状态 Hook 测试验证。 */
function create_basic_settings_state_fixture() {
  return {
    snapshot: {
      project_save_mode: "MANUAL",
      project_fixed_path: "",
      output_folder_open_on_finish: false,
      request_timeout: 300,
      network_proxy_mode: "system",
      network_proxy_address: "127.0.0.1:6789",
    },
    pending_state: {
      project_save_mode: false,
      output_folder_open_on_finish: false,
      request_timeout: false,
      network_proxy_mode: false,
      network_proxy_address: false,
    },
    languages: { source_language: "JA", target_language: "ZH" },
    language_pending_state: { source_language: false, target_language: false },
    language_locked: false,
    runtime_locked: false,
    update_source_language: vi.fn(async (_next_language: string) => {}),
    update_target_language: vi.fn(async (_next_language: string) => {}),
    update_project_save_mode: vi.fn(async (_next_mode: "MANUAL" | "FIXED" | "SOURCE") => {}),
    update_output_folder_open_on_finish: vi.fn(async (_next_checked: boolean) => {}),
    update_request_timeout: vi.fn(async (_next_value: number) => {}),
    update_network_proxy_mode: vi.fn(async (_next_mode: "system" | "proxy" | "direct") => {}),
    update_network_proxy_address: vi.fn(async (_next_address: string) => {}),
  };
}

/** 经原生 setter 和输入事件触发 React 的受控输入更新。 */
function set_input_value(input: HTMLInputElement, value: string): void {
  const value_setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  if (value_setter === undefined) {
    throw new Error("当前测试环境缺少 input value setter。");
  }

  value_setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 读取当前用例的隔离夹具，未初始化时立即暴露错误。 */
function get_current_basic_settings_state(): ReturnType<
  typeof create_basic_settings_state_fixture
> {
  if (basic_settings_state_fixture.current === null) {
    throw new Error("基础设置页面测试状态尚未初始化。");
  }

  return basic_settings_state_fixture.current;
}

describe("BasicSettingsPage", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    basic_settings_state_fixture.current = create_basic_settings_state_fixture();
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
    push_toast_mock.mockReset();
  });

  /** 挂载真实页面以验证输入、失焦与键盘提交。 */
  async function mount_page(): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<BasicSettingsPage is_sidebar_collapsed={false} />);
    });
  }

  /** 在页面中定位超时输入，缺失时终止当前测试。 */
  function get_request_timeout_input(): HTMLInputElement {
    const input = container?.querySelector('input[type="number"]');

    if (!(input instanceof HTMLInputElement)) {
      throw new Error("未找到请求超时时间输入框。");
    }

    return input;
  }

  function get_network_proxy_address_input(): HTMLInputElement {
    const input = container?.querySelector('input[type="text"]');

    if (!(input instanceof HTMLInputElement)) {
      throw new Error("未找到代理地址输入框。");
    }

    return input;
  }

  it("输入请求超时时间时只更新本地草稿，失焦后再提交", async () => {
    await mount_page();
    const input = get_request_timeout_input();

    await act(async () => {
      set_input_value(input, "1234");
    });

    expect(get_current_basic_settings_state().update_request_timeout).not.toHaveBeenCalled();

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(get_current_basic_settings_state().update_request_timeout).toHaveBeenCalledTimes(1);
    expect(get_current_basic_settings_state().update_request_timeout).toHaveBeenCalledWith(1234);
  });

  it("提交非法请求超时时间时标记红框并弹 toast", async () => {
    await mount_page();
    const input = get_request_timeout_input();

    await act(async () => {
      set_input_value(input, "");
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(get_current_basic_settings_state().update_request_timeout).not.toHaveBeenCalled();
    expect(push_toast_mock).toHaveBeenCalledWith(
      "app.feedback.save_failed",
      "basic_settings_page.feedback.request_timeout_invalid",
    );
  });

  it("非自定义代理模式下地址输入禁用", async () => {
    await mount_page();

    expect(get_network_proxy_address_input().disabled).toBe(true);
  });

  it("自定义代理模式下失焦提交裁剪后的地址", async () => {
    basic_settings_state_fixture.current!.snapshot.network_proxy_mode = "proxy";
    await mount_page();
    const input = get_network_proxy_address_input();
    expect(input.disabled).toBe(false);

    await act(async () => {
      set_input_value(input, " 10.0.0.5:1080 ");
    });
    expect(get_current_basic_settings_state().update_network_proxy_address).not.toHaveBeenCalled();

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      get_current_basic_settings_state().update_network_proxy_address,
    ).toHaveBeenCalledExactlyOnceWith("10.0.0.5:1080");
  });

  it("提交非法代理地址时标记红框并弹 toast", async () => {
    basic_settings_state_fixture.current!.snapshot.network_proxy_mode = "proxy";
    await mount_page();
    const input = get_network_proxy_address_input();

    await act(async () => {
      set_input_value(input, "socks5://127.0.0.1:1080");
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(get_current_basic_settings_state().update_network_proxy_address).not.toHaveBeenCalled();
    expect(push_toast_mock).toHaveBeenCalledWith(
      "app.feedback.save_failed",
      "basic_settings_page.feedback.network_proxy_address_invalid",
    );
  });
});
