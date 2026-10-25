import { type ReactNode, act } from "react";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExpertSettingsPage } from "@frontend/pages/expert-settings-page/page";

const { expert_settings_state_fixture, push_toast_mock } = vi.hoisted(() => {
  return {
    expert_settings_state_fixture: {
      current: null as ReturnType<typeof create_expert_settings_state_fixture> | null,
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

vi.mock("@frontend/pages/expert-settings-page/use-expert-settings-state", () => {
  return {
    useExpertSettingsState: () => expert_settings_state_fixture.current,
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

/** 每次挂载使用独立的编辑状态和提交记录。 */
function create_expert_settings_state_fixture() {
  return {
    snapshot: {
      agent_auto_resume_enabled: true,
      agent_auto_resume_initial_delay: 5,
      agent_auto_resume_max_delay: 300,
      agent_auto_resume_max_attempts: 0,
      preceding_lines_threshold: 0,
      clean_ruby: false,
      deduplication_in_bilingual: false,
      write_translated_name_fields_to_file: false,
    },
    pending_state: {
      agent_auto_resume_enabled: false,
      agent_auto_resume_initial_delay: false,
      agent_auto_resume_max_delay: false,
      agent_auto_resume_max_attempts: false,
      preceding_lines_threshold: false,
      clean_ruby: false,
      deduplication_in_bilingual: false,
      write_translated_name_fields_to_file: false,
    },
    update_agent_auto_resume_enabled: vi.fn(async (_next_checked: boolean) => {}),
    update_agent_auto_resume_initial_delay: vi.fn(async (_next_value: number) => {}),
    update_agent_auto_resume_max_delay: vi.fn(async (_next_value: number) => {}),
    update_agent_auto_resume_max_attempts: vi.fn(async (_next_value: number) => {}),
    update_preceding_lines_threshold: vi.fn(async (_next_value: number) => {}),
    update_clean_ruby: vi.fn(async (_next_checked: boolean) => {}),
    update_deduplication_in_bilingual: vi.fn(async (_next_checked: boolean) => {}),
    update_write_translated_name_fields_to_file: vi.fn(async (_next_checked: boolean) => {}),
  };
}

/** 通过原生 setter 触发 React 受控输入的真实 input 路径。 */
function set_input_value(input: HTMLInputElement, value: string): void {
  const value_setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  if (value_setter === undefined) {
    throw new Error("当前测试环境缺少 input value setter。");
  }

  value_setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 断言前确认页面状态已经初始化。 */
function get_current_expert_settings_state(): ReturnType<
  typeof create_expert_settings_state_fixture
> {
  if (expert_settings_state_fixture.current === null) {
    throw new Error("专家设置页面测试状态尚未初始化。");
  }

  return expert_settings_state_fixture.current;
}

describe("ExpertSettingsPage", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    expert_settings_state_fixture.current = create_expert_settings_state_fixture();
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

  /** 在独立容器中挂载页面并等待状态生效。 */
  async function mount_page(): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ExpertSettingsPage is_sidebar_collapsed={false} />);
    });
  }

  /** 从页面按字段标题读取数值输入框，缺失时终止交互断言。 */
  function get_number_input(field: string): HTMLInputElement {
    const section = container?.querySelector(
      `section[aria-label="expert_settings_page.fields.${field}.title"]`,
    );
    const input = section?.querySelector('input[type="number"]');

    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`未找到 ${field} 输入框。`);
    }

    return input;
  }

  it("输入参考上文行数阈值时只更新本地草稿，失焦后再提交", async () => {
    await mount_page();
    const input = get_number_input("preceding_lines_threshold");

    await act(async () => {
      set_input_value(input, "12");
    });

    expect(
      get_current_expert_settings_state().update_preceding_lines_threshold,
    ).not.toHaveBeenCalled();

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      get_current_expert_settings_state().update_preceding_lines_threshold,
    ).toHaveBeenCalledTimes(1);
    expect(
      get_current_expert_settings_state().update_preceding_lines_threshold,
    ).toHaveBeenCalledWith(12);
  });

  it("提交非法参考上文行数阈值时标记红框并弹 toast", async () => {
    await mount_page();
    const input = get_number_input("preceding_lines_threshold");

    await act(async () => {
      set_input_value(input, "");
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      get_current_expert_settings_state().update_preceding_lines_threshold,
    ).not.toHaveBeenCalled();
    expect(push_toast_mock).toHaveBeenCalledWith(
      "app.feedback.save_failed",
      "expert_settings_page.feedback.preceding_lines_threshold_invalid",
    );
  });

  it("自动重试数值字段在失焦后提交，非法间隔保留草稿并提示", async () => {
    await mount_page();
    const initial_delay_input = get_number_input("agent_auto_resume_initial_delay");
    const max_delay_input = get_number_input("agent_auto_resume_max_delay");
    const max_attempts_input = get_number_input("agent_auto_resume_max_attempts");

    await act(async () => {
      set_input_value(initial_delay_input, "12");
      set_input_value(max_delay_input, "600");
      set_input_value(max_attempts_input, "0");
    });

    expect(
      get_current_expert_settings_state().update_agent_auto_resume_initial_delay,
    ).not.toHaveBeenCalled();

    await act(async () => {
      initial_delay_input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      max_delay_input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      max_attempts_input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      get_current_expert_settings_state().update_agent_auto_resume_initial_delay,
    ).toHaveBeenCalledWith(12);
    expect(
      get_current_expert_settings_state().update_agent_auto_resume_max_delay,
    ).toHaveBeenCalledWith(600);
    // 与已保存值相同，不重复提交。
    expect(
      get_current_expert_settings_state().update_agent_auto_resume_max_attempts,
    ).not.toHaveBeenCalled();

    await act(async () => {
      set_input_value(initial_delay_input, "");
    });

    expect(initial_delay_input.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      initial_delay_input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(push_toast_mock).toHaveBeenCalledWith(
      "app.feedback.save_failed",
      "expert_settings_page.feedback.agent_auto_resume_initial_delay_invalid",
    );
  });
});
