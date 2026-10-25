import { useCallback } from "react";

import {
  AGENT_AUTO_CONTINUE_MAX_CONTINUES_LIMIT,
  AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MAX,
  AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MIN,
  AGENT_AUTO_RESUME_MAX_ATTEMPTS_LIMIT,
  AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MAX,
  AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MIN,
} from "@domain/setting";
import { useSettingsEditor } from "@frontend/features/settings-editor/use-settings-editor";
import {
  PRECEDING_LINES_THRESHOLD_MAX,
  PRECEDING_LINES_THRESHOLD_MIN,
  build_expert_settings_snapshot,
  type ExpertSettingsSnapshot,
} from "@frontend/pages/expert-settings-page/types";

const EXPERT_SETTINGS_PENDING_FIELDS = [
  "agent_auto_resume_enabled",
  "agent_auto_resume_initial_delay",
  "agent_auto_resume_max_delay",
  "agent_auto_resume_max_attempts",
  "agent_auto_continue_enabled",
  "agent_auto_continue_max_continues",
  "preceding_lines_threshold",
  "clean_ruby",
  "deduplication_in_bilingual",
  "write_translated_name_fields_to_file",
] as const;

type ExpertSettingsPendingField = (typeof EXPERT_SETTINGS_PENDING_FIELDS)[number];

type UseExpertSettingsStateResult = {
  snapshot: ExpertSettingsSnapshot;
  pending_state: Record<ExpertSettingsPendingField, boolean>;
  update_agent_auto_resume_enabled: (next_checked: boolean) => Promise<void>;
  update_agent_auto_resume_initial_delay: (next_value: number) => Promise<void>;
  update_agent_auto_resume_max_delay: (next_value: number) => Promise<void>;
  update_agent_auto_resume_max_attempts: (next_value: number) => Promise<void>;
  update_agent_auto_continue_enabled: (next_checked: boolean) => Promise<void>;
  update_agent_auto_continue_max_continues: (next_value: number) => Promise<void>;
  update_preceding_lines_threshold: (next_value: number) => Promise<void>;
  update_clean_ruby: (next_checked: boolean) => Promise<void>;
  update_deduplication_in_bilingual: (next_checked: boolean) => Promise<void>;
  update_write_translated_name_fields_to_file: (next_checked: boolean) => Promise<void>;
};

/** 数值设置统一取整并收窄到后端允许的区间。 */
function clamp_integer_setting(next_value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(next_value)));
}

/**
 * 将专家设置字段交给共享设置编辑器，保存后由各执行入口读取。
 */
export function useExpertSettingsState(): UseExpertSettingsStateResult {
  const { snapshot, pending_state, commit_update } = useSettingsEditor({
    select_snapshot: build_expert_settings_snapshot,
    pending_fields: EXPERT_SETTINGS_PENDING_FIELDS,
  });
  const update_agent_auto_resume_enabled = useCallback(
    async (next_checked: boolean): Promise<void> => {
      if (snapshot.agent_auto_resume_enabled !== next_checked) {
        await commit_update("agent_auto_resume_enabled", {
          agent_auto_resume_enabled: next_checked,
        });
      }
    },
    [commit_update, snapshot.agent_auto_resume_enabled],
  );

  const update_agent_auto_resume_initial_delay = useCallback(
    async (next_value: number): Promise<void> => {
      const normalized = clamp_integer_setting(
        next_value,
        AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MIN,
        AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MAX,
      );
      if (Number.isNaN(normalized) || snapshot.agent_auto_resume_initial_delay === normalized) {
        return;
      }

      await commit_update("agent_auto_resume_initial_delay", {
        agent_auto_resume_initial_delay: normalized,
      });
    },
    [commit_update, snapshot.agent_auto_resume_initial_delay],
  );

  const update_agent_auto_resume_max_delay = useCallback(
    async (next_value: number): Promise<void> => {
      const normalized = clamp_integer_setting(
        next_value,
        AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MIN,
        AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MAX,
      );
      if (Number.isNaN(normalized) || snapshot.agent_auto_resume_max_delay === normalized) {
        return;
      }

      await commit_update("agent_auto_resume_max_delay", {
        agent_auto_resume_max_delay: normalized,
      });
    },
    [commit_update, snapshot.agent_auto_resume_max_delay],
  );

  const update_agent_auto_resume_max_attempts = useCallback(
    async (next_value: number): Promise<void> => {
      const normalized = clamp_integer_setting(next_value, 0, AGENT_AUTO_RESUME_MAX_ATTEMPTS_LIMIT);
      if (Number.isNaN(normalized) || snapshot.agent_auto_resume_max_attempts === normalized) {
        return;
      }

      await commit_update("agent_auto_resume_max_attempts", {
        agent_auto_resume_max_attempts: normalized,
      });
    },
    [commit_update, snapshot.agent_auto_resume_max_attempts],
  );

  const update_agent_auto_continue_enabled = useCallback(
    async (next_checked: boolean): Promise<void> => {
      if (snapshot.agent_auto_continue_enabled !== next_checked) {
        await commit_update("agent_auto_continue_enabled", {
          agent_auto_continue_enabled: next_checked,
        });
      }
    },
    [commit_update, snapshot.agent_auto_continue_enabled],
  );

  const update_agent_auto_continue_max_continues = useCallback(
    async (next_value: number): Promise<void> => {
      const normalized = clamp_integer_setting(
        next_value,
        0,
        AGENT_AUTO_CONTINUE_MAX_CONTINUES_LIMIT,
      );
      if (Number.isNaN(normalized) || snapshot.agent_auto_continue_max_continues === normalized) {
        return;
      }

      await commit_update("agent_auto_continue_max_continues", {
        agent_auto_continue_max_continues: normalized,
      });
    },
    [commit_update, snapshot.agent_auto_continue_max_continues],
  );

  const update_preceding_lines_threshold = useCallback(
    async (next_value: number): Promise<void> => {
      const normalized_threshold = clamp_integer_setting(
        next_value,
        PRECEDING_LINES_THRESHOLD_MIN,
        PRECEDING_LINES_THRESHOLD_MAX,
      );
      if (
        Number.isNaN(normalized_threshold) ||
        snapshot.preceding_lines_threshold === normalized_threshold
      ) {
        return;
      }

      await commit_update("preceding_lines_threshold", {
        preceding_lines_threshold: normalized_threshold,
      });
    },
    [commit_update, snapshot.preceding_lines_threshold],
  );

  const update_clean_ruby = useCallback(
    async (next_checked: boolean): Promise<void> => {
      if (snapshot.clean_ruby !== next_checked) {
        await commit_update("clean_ruby", {
          clean_ruby: next_checked,
        });
      }
    },
    [commit_update, snapshot.clean_ruby],
  );

  const update_deduplication_in_bilingual = useCallback(
    async (next_checked: boolean): Promise<void> => {
      if (snapshot.deduplication_in_bilingual !== next_checked) {
        await commit_update("deduplication_in_bilingual", {
          deduplication_in_bilingual: next_checked,
        });
      }
    },
    [commit_update, snapshot.deduplication_in_bilingual],
  );

  const update_write_translated_name_fields_to_file = useCallback(
    async (next_checked: boolean): Promise<void> => {
      if (snapshot.write_translated_name_fields_to_file !== next_checked) {
        await commit_update("write_translated_name_fields_to_file", {
          write_translated_name_fields_to_file: next_checked,
        });
      }
    },
    [commit_update, snapshot.write_translated_name_fields_to_file],
  );

  return {
    snapshot,
    pending_state,
    update_agent_auto_resume_enabled,
    update_agent_auto_resume_initial_delay,
    update_agent_auto_resume_max_delay,
    update_agent_auto_resume_max_attempts,
    update_agent_auto_continue_enabled,
    update_agent_auto_continue_max_continues,
    update_preceding_lines_threshold,
    update_clean_ruby,
    update_deduplication_in_bilingual,
    update_write_translated_name_fields_to_file,
  };
}
