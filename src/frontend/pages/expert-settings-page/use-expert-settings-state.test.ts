import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExpertSettingsSnapshot } from "./types";
import { useExpertSettingsState } from "./use-expert-settings-state";

const commit_update = vi.fn(async () => null);
const snapshot: ExpertSettingsSnapshot = {
  agent_auto_resume_enabled: true,
  agent_auto_resume_initial_delay: 5,
  agent_auto_resume_max_delay: 300,
  agent_auto_resume_max_attempts: 0,
  preceding_lines_threshold: 3,
  clean_ruby: false,
  deduplication_in_bilingual: false,
  write_translated_name_fields_to_file: false,
};

vi.mock("@frontend/features/settings-editor/use-settings-editor", () => ({
  useSettingsEditor: () => ({
    snapshot,
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
    commit_update,
  }),
}));

describe("useExpertSettingsState", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let latest_state: ReturnType<typeof useExpertSettingsState> | null = null;

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
    latest_state = null;
    commit_update.mockClear();
  });

  /** 记录本次渲染返回的编辑入口。 */
  function Probe(): null {
    latest_state = useExpertSettingsState();
    return null;
  }

  /** 挂载探针并等待编辑入口可用。 */
  async function render_hook(): Promise<void> {
    if (container === null) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root?.render(createElement(Probe));
    });
  }

  it("在页面边界归一化阈值后提交", async () => {
    await render_hook();

    await act(async () => {
      await latest_state?.update_preceding_lines_threshold(-1);
    });

    expect(commit_update).toHaveBeenCalledWith("preceding_lines_threshold", {
      preceding_lines_threshold: 0,
    });
  });

  it("自动重试设置按整数与边界提交，开关单独保存", async () => {
    await render_hook();

    await act(async () => {
      await latest_state?.update_agent_auto_resume_enabled(false);
      await latest_state?.update_agent_auto_resume_initial_delay(2.9);
      await latest_state?.update_agent_auto_resume_max_delay(999_999);
      await latest_state?.update_agent_auto_resume_max_attempts(1_200);
    });

    expect(commit_update).toHaveBeenCalledWith("agent_auto_resume_enabled", {
      agent_auto_resume_enabled: false,
    });
    expect(commit_update).toHaveBeenCalledWith("agent_auto_resume_initial_delay", {
      agent_auto_resume_initial_delay: 2,
    });
    expect(commit_update).toHaveBeenCalledWith("agent_auto_resume_max_delay", {
      agent_auto_resume_max_delay: 86_400,
    });
    expect(commit_update).toHaveBeenCalledWith("agent_auto_resume_max_attempts", {
      agent_auto_resume_max_attempts: 1_000,
    });
  });

  it("自动重试设置与已保存值相同时不提交", async () => {
    await render_hook();

    await act(async () => {
      await latest_state?.update_agent_auto_resume_enabled(true);
      await latest_state?.update_agent_auto_resume_initial_delay(5);
      await latest_state?.update_agent_auto_resume_max_delay(300);
      await latest_state?.update_agent_auto_resume_max_attempts(0);
    });

    expect(commit_update).not.toHaveBeenCalled();
  });
});
