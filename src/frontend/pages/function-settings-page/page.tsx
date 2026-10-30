import { type JSX } from "react";
import {
  AGENT_AUTO_CONTINUE_MAX_CONTINUES_LIMIT,
  AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MAX,
  AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MIN,
  AGENT_AUTO_RESUME_MAX_ATTEMPTS_LIMIT,
  AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MAX,
  AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MIN,
  CONTEXT_LINES_THRESHOLD_MAX,
  CONTEXT_LINES_THRESHOLD_MIN,
  TRANSLATION_SAVE_MODES,
  PROJECT_SAVE_MODES,
  is_network_proxy_address,
  is_network_proxy_mode,
  is_project_save_mode,
  is_translation_save_mode,
} from "@domain/setting";
import { SaveLocationRow } from "./save-location-row";
import { NumberSettingRow } from "./number-setting-row";
import { TextSettingRow } from "./text-setting-row";

import { useI18n } from "@frontend/app/locale/locale-context";
import "@frontend/pages/function-settings-page/function-settings-page.css";
import {
  NETWORK_PROXY_MODE_LABEL_KEYS,
  NETWORK_PROXY_MODE_OPTIONS,
  PROJECT_SAVE_MODE_LABEL_KEYS,
  TRANSLATION_SAVE_MODE_LABEL_KEYS,
  REQUEST_TIMEOUT_MAX,
  REQUEST_TIMEOUT_MIN,
} from "@frontend/pages/function-settings-page/types";
import { ProjectLanguageSelect } from "@frontend/features/project-language/project-language-select";
import { useFunctionSettingsState } from "@frontend/pages/function-settings-page/use-function-settings-state";
import { BooleanSegmentedToggle } from "@frontend/widgets/boolean-segmented-toggle";
import { SettingCardRow } from "@frontend/widgets/setting-card-row/setting-card-row";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@frontend/shadcn/select";

type FunctionSettingsPageProps = {
  is_sidebar_collapsed: boolean;
};
/** 保留数值输入草稿，在失焦或确认后提交设置。 */
export function FunctionSettingsPage(_props: FunctionSettingsPageProps): JSX.Element {
  const { t } = useI18n();

  const function_settings_state = useFunctionSettingsState();
  const project_save_mode_options = PROJECT_SAVE_MODES.map((mode) => ({
    value: mode,
    label: t(PROJECT_SAVE_MODE_LABEL_KEYS[mode]),
  }));
  const translation_save_mode_options = TRANSLATION_SAVE_MODES.map((mode) => ({
    value: mode,
    label: t(TRANSLATION_SAVE_MODE_LABEL_KEYS[mode]),
  }));
  const network_proxy_mode_options = NETWORK_PROXY_MODE_OPTIONS.map((mode) => ({
    value: mode,
    label: t(NETWORK_PROXY_MODE_LABEL_KEYS[mode]),
  }));

  const language_locked = function_settings_state.language_locked;

  return (
    <div className="function-settings-page page-shell page-shell--full">
      <section
        className="function-settings-page__list"
        aria-label={t("function_settings_page.title")}
      >
        <SettingCardRow
          action_width="content"
          title={t("app.language_role.source")}
          description={t("function_settings_page.fields.source_language.description")}
          action={
            <ProjectLanguageSelect
              field="source_language"
              value={function_settings_state.languages.source_language}
              disabled={
                language_locked || function_settings_state.language_pending_state.source_language
              }
              on_change={(next_value) => {
                void function_settings_state.update_source_language(next_value);
              }}
            />
          }
        />

        <SettingCardRow
          action_width="content"
          title={t("app.language_role.target")}
          description={t("function_settings_page.fields.target_language.description")}
          action={
            <ProjectLanguageSelect
              field="target_language"
              value={function_settings_state.languages.target_language}
              disabled={
                language_locked || function_settings_state.language_pending_state.target_language
              }
              on_change={(next_value) => {
                void function_settings_state.update_target_language(next_value);
              }}
            />
          }
        />

        <NumberSettingRow
          title={t("function_settings_page.fields.preceding_lines_threshold.title")}
          description={t("function_settings_page.fields.preceding_lines_threshold.description")}
          invalid_message={t("function_settings_page.feedback.preceding_lines_threshold_invalid")}
          value={function_settings_state.snapshot.preceding_lines_threshold}
          pending={function_settings_state.pending_state.preceding_lines_threshold}
          min={CONTEXT_LINES_THRESHOLD_MIN}
          max={CONTEXT_LINES_THRESHOLD_MAX}
          integer={true}
          on_commit={function_settings_state.update_preceding_lines_threshold}
        />

        <NumberSettingRow
          title={t("function_settings_page.fields.following_lines_threshold.title")}
          description={t("function_settings_page.fields.following_lines_threshold.description")}
          invalid_message={t("function_settings_page.feedback.following_lines_threshold_invalid")}
          value={function_settings_state.snapshot.following_lines_threshold}
          pending={function_settings_state.pending_state.following_lines_threshold}
          min={CONTEXT_LINES_THRESHOLD_MIN}
          max={CONTEXT_LINES_THRESHOLD_MAX}
          integer={true}
          on_commit={function_settings_state.update_following_lines_threshold}
        />

        <NumberSettingRow
          title={t("function_settings_page.fields.request_timeout.title")}
          description={t("function_settings_page.fields.request_timeout.description")}
          invalid_message={t("function_settings_page.feedback.request_timeout_invalid")}
          value={function_settings_state.snapshot.request_timeout}
          pending={function_settings_state.pending_state.request_timeout}
          min={REQUEST_TIMEOUT_MIN}
          max={REQUEST_TIMEOUT_MAX}
          integer={false}
          on_commit={function_settings_state.update_request_timeout}
        />

        <SaveLocationRow
          title={t("function_settings_page.fields.project_save_mode.title")}
          description={t("function_settings_page.fields.project_save_mode.description")}
          options={project_save_mode_options}
          mode={function_settings_state.snapshot.project_save_mode}
          fixed_path={function_settings_state.snapshot.project_fixed_path}
          busy={
            function_settings_state.pending_state.project_save_mode ||
            function_settings_state.choosing_directory.project_save_mode
          }
          on_mode_change={(value) => {
            if (is_project_save_mode(value))
              void function_settings_state.update_project_save_mode(value);
          }}
        />
        <SaveLocationRow
          title={t("function_settings_page.fields.translation_save_mode.title")}
          description={t("function_settings_page.fields.translation_save_mode.description")}
          options={translation_save_mode_options}
          mode={function_settings_state.snapshot.translation_save_mode}
          fixed_path={function_settings_state.snapshot.translation_fixed_path}
          busy={
            function_settings_state.pending_state.translation_save_mode ||
            function_settings_state.choosing_directory.translation_save_mode
          }
          on_mode_change={(value) => {
            if (is_translation_save_mode(value))
              void function_settings_state.update_translation_save_mode(value);
          }}
        />

        <SettingCardRow
          title={t("function_settings_page.fields.output_folder_open_on_finish.title")}
          description={t("function_settings_page.fields.output_folder_open_on_finish.description")}
          action={
            <BooleanSegmentedToggle
              aria_label={t("function_settings_page.fields.output_folder_open_on_finish.title")}
              value={function_settings_state.snapshot.output_folder_open_on_finish}
              stretch
              disabled={function_settings_state.pending_state.output_folder_open_on_finish}
              on_value_change={(next_value) => {
                void function_settings_state.update_output_folder_open_on_finish(next_value);
              }}
            />
          }
        />

        <SettingCardRow
          action_width="content"
          title={t("function_settings_page.fields.network_proxy_mode.title")}
          description={t("function_settings_page.fields.network_proxy_mode.description")}
          action={
            <Select
              items={network_proxy_mode_options}
              value={function_settings_state.snapshot.network_proxy_mode}
              disabled={function_settings_state.pending_state.network_proxy_mode}
              onValueChange={(next_value) => {
                if (next_value !== null && is_network_proxy_mode(next_value)) {
                  void function_settings_state.update_network_proxy_mode(next_value);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {network_proxy_mode_options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          }
        />

        <TextSettingRow
          title={t("function_settings_page.fields.network_proxy_address.title")}
          description={t("function_settings_page.fields.network_proxy_address.description")}
          invalid_message={t("function_settings_page.feedback.network_proxy_address_invalid")}
          value={function_settings_state.snapshot.network_proxy_address}
          pending={function_settings_state.pending_state.network_proxy_address}
          // 自定义代理地址只在自定义模式下生效，其它模式沿用当前已保存值显示。
          disabled={function_settings_state.snapshot.network_proxy_mode !== "proxy"}
          validate={is_network_proxy_address}
          on_commit={function_settings_state.update_network_proxy_address}
        />

        <SettingCardRow
          title={t("function_settings_page.fields.agent_term_lookup_enabled.title")}
          description={t("function_settings_page.fields.agent_term_lookup_enabled.description")}
          action={
            <BooleanSegmentedToggle
              aria_label={t("function_settings_page.fields.agent_term_lookup_enabled.title")}
              value={function_settings_state.snapshot.agent_term_lookup_enabled}
              stretch
              disabled={function_settings_state.pending_state.agent_term_lookup_enabled}
              on_value_change={(next_value) => {
                void function_settings_state.update_agent_term_lookup_enabled(next_value);
              }}
            />
          }
        />

        <SettingCardRow
          title={t("function_settings_page.fields.agent_auto_resume_enabled.title")}
          description={t("function_settings_page.fields.agent_auto_resume_enabled.description")}
          action={
            <BooleanSegmentedToggle
              aria_label={t("function_settings_page.fields.agent_auto_resume_enabled.title")}
              value={function_settings_state.snapshot.agent_auto_resume_enabled}
              stretch
              disabled={function_settings_state.pending_state.agent_auto_resume_enabled}
              on_value_change={(next_value) => {
                void function_settings_state.update_agent_auto_resume_enabled(next_value);
              }}
            />
          }
        />

        <NumberSettingRow
          title={t("function_settings_page.fields.agent_auto_resume_initial_delay.title")}
          description={t(
            "function_settings_page.fields.agent_auto_resume_initial_delay.description",
          )}
          invalid_message={t(
            "function_settings_page.feedback.agent_auto_resume_initial_delay_invalid",
          )}
          value={function_settings_state.snapshot.agent_auto_resume_initial_delay}
          pending={function_settings_state.pending_state.agent_auto_resume_initial_delay}
          min={AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MIN}
          max={AGENT_AUTO_RESUME_INITIAL_DELAY_SECONDS_MAX}
          integer={true}
          on_commit={function_settings_state.update_agent_auto_resume_initial_delay}
        />

        <NumberSettingRow
          title={t("function_settings_page.fields.agent_auto_resume_max_delay.title")}
          description={t("function_settings_page.fields.agent_auto_resume_max_delay.description")}
          invalid_message={t("function_settings_page.feedback.agent_auto_resume_max_delay_invalid")}
          value={function_settings_state.snapshot.agent_auto_resume_max_delay}
          pending={function_settings_state.pending_state.agent_auto_resume_max_delay}
          min={AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MIN}
          max={AGENT_AUTO_RESUME_MAX_DELAY_SECONDS_MAX}
          integer={true}
          on_commit={function_settings_state.update_agent_auto_resume_max_delay}
        />

        <NumberSettingRow
          title={t("function_settings_page.fields.agent_auto_resume_max_attempts.title")}
          description={t(
            "function_settings_page.fields.agent_auto_resume_max_attempts.description",
          )}
          invalid_message={t(
            "function_settings_page.feedback.agent_auto_resume_max_attempts_invalid",
          )}
          value={function_settings_state.snapshot.agent_auto_resume_max_attempts}
          pending={function_settings_state.pending_state.agent_auto_resume_max_attempts}
          min={0}
          max={AGENT_AUTO_RESUME_MAX_ATTEMPTS_LIMIT}
          integer={true}
          on_commit={function_settings_state.update_agent_auto_resume_max_attempts}
        />

        <SettingCardRow
          title={t("function_settings_page.fields.agent_auto_continue_enabled.title")}
          description={t("function_settings_page.fields.agent_auto_continue_enabled.description")}
          action={
            <BooleanSegmentedToggle
              aria_label={t("function_settings_page.fields.agent_auto_continue_enabled.title")}
              value={function_settings_state.snapshot.agent_auto_continue_enabled}
              stretch
              disabled={function_settings_state.pending_state.agent_auto_continue_enabled}
              on_value_change={(next_value) => {
                void function_settings_state.update_agent_auto_continue_enabled(next_value);
              }}
            />
          }
        />

        <NumberSettingRow
          title={t("function_settings_page.fields.agent_auto_continue_max_continues.title")}
          description={t(
            "function_settings_page.fields.agent_auto_continue_max_continues.description",
          )}
          invalid_message={t(
            "function_settings_page.feedback.agent_auto_continue_max_continues_invalid",
          )}
          value={function_settings_state.snapshot.agent_auto_continue_max_continues}
          pending={function_settings_state.pending_state.agent_auto_continue_max_continues}
          min={0}
          max={AGENT_AUTO_CONTINUE_MAX_CONTINUES_LIMIT}
          integer={true}
          on_commit={function_settings_state.update_agent_auto_continue_max_continues}
        />
      </section>
    </div>
  );
}
