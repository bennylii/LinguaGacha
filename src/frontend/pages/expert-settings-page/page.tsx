import { type JSX } from "react";

import {
  AGENT_AUTO_CONTINUE_MAX_CONTINUES_LIMIT,
  AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MAX,
  AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MIN,
  AGENT_AUTO_RESUME_MAX_ATTEMPTS_LIMIT,
  AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MAX,
  AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MIN,
} from "@domain/setting";
import { useI18n } from "@frontend/app/locale/locale-context";
import "@frontend/pages/expert-settings-page/expert-settings-page.css";
import {
  PRECEDING_LINES_THRESHOLD_MAX,
  PRECEDING_LINES_THRESHOLD_MIN,
} from "@frontend/pages/expert-settings-page/types";
import {
  useNumberSettingDraft,
  type NumberSettingDraft,
} from "@frontend/pages/expert-settings-page/use-number-setting-draft";
import { useExpertSettingsState } from "@frontend/pages/expert-settings-page/use-expert-settings-state";
import { Input } from "@frontend/shadcn/input";
import type { LocaleKey } from "@shared/i18n";
import { BooleanSegmentedToggle } from "@frontend/widgets/boolean-segmented-toggle";
import { SettingCardRow } from "@frontend/widgets/setting-card-row/setting-card-row";

type ExpertSettingsPageProps = {
  is_sidebar_collapsed: boolean;
};

/** 编辑器保存应用设置；数值草稿在提交前保留本地输入。 */
export function ExpertSettingsPage(_props: ExpertSettingsPageProps): JSX.Element {
  const { t } = useI18n();

  const expert_settings_state = useExpertSettingsState();
  const agent_auto_resume_initial_delay_draft = useNumberSettingDraft({
    value: expert_settings_state.snapshot.agent_auto_resume_initial_delay,
    min: AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MIN,
    max: AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MAX,
    invalid_message: "expert_settings_page.feedback.agent_auto_resume_initial_delay_invalid",
    commit: expert_settings_state.update_agent_auto_resume_initial_delay,
  });
  const agent_auto_resume_max_delay_draft = useNumberSettingDraft({
    value: expert_settings_state.snapshot.agent_auto_resume_max_delay,
    min: AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MIN,
    max: AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MAX,
    invalid_message: "expert_settings_page.feedback.agent_auto_resume_max_delay_invalid",
    commit: expert_settings_state.update_agent_auto_resume_max_delay,
  });
  const agent_auto_resume_max_attempts_draft = useNumberSettingDraft({
    value: expert_settings_state.snapshot.agent_auto_resume_max_attempts,
    min: 0,
    max: AGENT_AUTO_RESUME_MAX_ATTEMPTS_LIMIT,
    invalid_message: "expert_settings_page.feedback.agent_auto_resume_max_attempts_invalid",
    commit: expert_settings_state.update_agent_auto_resume_max_attempts,
  });
  const agent_auto_continue_max_continues_draft = useNumberSettingDraft({
    value: expert_settings_state.snapshot.agent_auto_continue_max_continues,
    min: 0,
    max: AGENT_AUTO_CONTINUE_MAX_CONTINUES_LIMIT,
    invalid_message: "expert_settings_page.feedback.agent_auto_continue_max_continues_invalid",
    commit: expert_settings_state.update_agent_auto_continue_max_continues,
  });
  const preceding_lines_threshold_draft = useNumberSettingDraft({
    value: expert_settings_state.snapshot.preceding_lines_threshold,
    min: PRECEDING_LINES_THRESHOLD_MIN,
    max: PRECEDING_LINES_THRESHOLD_MAX,
    invalid_message: "expert_settings_page.feedback.preceding_lines_threshold_invalid",
    commit: expert_settings_state.update_preceding_lines_threshold,
  });
  /** 开关复用可见标题作为无障碍名称。 */
  function render_boolean_toggle(options: {
    title_key: LocaleKey;
    value: boolean;
    disabled: boolean;
    on_value_change: (next_value: boolean) => void;
  }): JSX.Element {
    return (
      <BooleanSegmentedToggle
        aria_label={t(options.title_key)}
        value={options.value}
        stretch
        disabled={options.disabled}
        on_value_change={options.on_value_change}
      />
    );
  }
  /** 数值行共用同一提交草稿控件，避免四个字段各自维护输入状态。 */
  function render_number_field(
    draft: NumberSettingDraft,
    min: number,
    max: number,
    disabled: boolean,
  ): JSX.Element {
    return (
      <div className="expert-settings-page__number-field">
        <Input
          type="number"
          min={min}
          max={max}
          value={draft.draft}
          aria-invalid={draft.invalid || undefined}
          disabled={disabled}
          onChange={(event) => {
            draft.on_change(event.target.value);
          }}
          onBlur={draft.on_blur}
          onKeyDown={draft.on_key_down}
          onFocus={draft.on_focus}
        />
      </div>
    );
  }

  return (
    <div className="expert-settings-page page-shell page-shell--full">
      <section className="expert-settings-page__list" aria-label={t("expert_settings_page.title")}>
        <SettingCardRow
          title={t("expert_settings_page.fields.agent_auto_resume_enabled.title")}
          description={t("expert_settings_page.fields.agent_auto_resume_enabled.description")}
          action={render_boolean_toggle({
            title_key: "expert_settings_page.fields.agent_auto_resume_enabled.title",
            value: expert_settings_state.snapshot.agent_auto_resume_enabled,
            disabled: expert_settings_state.pending_state.agent_auto_resume_enabled,
            on_value_change: (next_value) => {
              void expert_settings_state.update_agent_auto_resume_enabled(next_value);
            },
          })}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.agent_auto_resume_initial_delay.title")}
          description={t("expert_settings_page.fields.agent_auto_resume_initial_delay.description")}
          action={render_number_field(
            agent_auto_resume_initial_delay_draft,
            AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MIN,
            AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MAX,
            expert_settings_state.pending_state.agent_auto_resume_initial_delay,
          )}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.agent_auto_resume_max_delay.title")}
          description={t("expert_settings_page.fields.agent_auto_resume_max_delay.description")}
          action={render_number_field(
            agent_auto_resume_max_delay_draft,
            AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MIN,
            AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MAX,
            expert_settings_state.pending_state.agent_auto_resume_max_delay,
          )}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.agent_auto_resume_max_attempts.title")}
          description={t("expert_settings_page.fields.agent_auto_resume_max_attempts.description")}
          action={render_number_field(
            agent_auto_resume_max_attempts_draft,
            0,
            AGENT_AUTO_RESUME_MAX_ATTEMPTS_LIMIT,
            expert_settings_state.pending_state.agent_auto_resume_max_attempts,
          )}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.agent_auto_continue_enabled.title")}
          description={t("expert_settings_page.fields.agent_auto_continue_enabled.description")}
          action={render_boolean_toggle({
            title_key: "expert_settings_page.fields.agent_auto_continue_enabled.title",
            value: expert_settings_state.snapshot.agent_auto_continue_enabled,
            disabled: expert_settings_state.pending_state.agent_auto_continue_enabled,
            on_value_change: (next_value) => {
              void expert_settings_state.update_agent_auto_continue_enabled(next_value);
            },
          })}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.agent_auto_continue_max_continues.title")}
          description={t(
            "expert_settings_page.fields.agent_auto_continue_max_continues.description",
          )}
          action={render_number_field(
            agent_auto_continue_max_continues_draft,
            0,
            AGENT_AUTO_CONTINUE_MAX_CONTINUES_LIMIT,
            expert_settings_state.pending_state.agent_auto_continue_max_continues,
          )}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.preceding_lines_threshold.title")}
          description={t("expert_settings_page.fields.preceding_lines_threshold.description")}
          action={render_number_field(
            preceding_lines_threshold_draft,
            PRECEDING_LINES_THRESHOLD_MIN,
            PRECEDING_LINES_THRESHOLD_MAX,
            expert_settings_state.pending_state.preceding_lines_threshold,
          )}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.clean_ruby.title")}
          description={t("expert_settings_page.fields.clean_ruby.description")}
          action={render_boolean_toggle({
            title_key: "expert_settings_page.fields.clean_ruby.title",
            value: expert_settings_state.snapshot.clean_ruby,
            disabled: expert_settings_state.pending_state.clean_ruby,
            on_value_change: (next_value) => {
              void expert_settings_state.update_clean_ruby(next_value);
            },
          })}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.deduplication_in_bilingual.title")}
          description={t("expert_settings_page.fields.deduplication_in_bilingual.description")}
          action={render_boolean_toggle({
            title_key: "expert_settings_page.fields.deduplication_in_bilingual.title",
            value: expert_settings_state.snapshot.deduplication_in_bilingual,
            disabled: expert_settings_state.pending_state.deduplication_in_bilingual,
            on_value_change: (next_value) => {
              void expert_settings_state.update_deduplication_in_bilingual(next_value);
            },
          })}
        />

        <SettingCardRow
          title={t("expert_settings_page.fields.write_translated_name_fields_to_file.title")}
          description={t(
            "expert_settings_page.fields.write_translated_name_fields_to_file.description",
          )}
          action={render_boolean_toggle({
            title_key: "expert_settings_page.fields.write_translated_name_fields_to_file.title",
            value: expert_settings_state.snapshot.write_translated_name_fields_to_file,
            disabled: expert_settings_state.pending_state.write_translated_name_fields_to_file,
            on_value_change: (next_value) => {
              void expert_settings_state.update_write_translated_name_fields_to_file(next_value);
            },
          })}
        />
      </section>
    </div>
  );
}
