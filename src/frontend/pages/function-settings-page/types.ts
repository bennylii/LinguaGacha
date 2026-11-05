import type { SettingsSnapshot } from "@frontend/app/state/desktop-state-context";
import type { LocaleKey } from "@frontend/app/locale/locale-context";
import type { NetworkProxyMode, ProjectSaveMode, TranslationSaveMode } from "@domain/setting";
import { NETWORK_PROXY_MODES } from "@domain/setting";

/** 请求超时输入框接受的后端协议边界。 */
export const REQUEST_TIMEOUT_MIN = 0;
export const REQUEST_TIMEOUT_MAX = 9_999_999;

export type FunctionSettingsSnapshot = Pick<
  SettingsSnapshot,
  | "preceding_lines_threshold"
  | "following_lines_threshold"
  | "project_save_mode"
  | "project_fixed_path"
  | "translation_save_mode"
  | "translation_fixed_path"
  | "output_folder_open_on_finish"
  | "request_timeout"
  | "network_proxy_mode"
  | "network_proxy_address"
  | "agent_term_lookup_enabled"
  | "agent_auto_resume_enabled"
  | "agent_auto_resume_initial_delay"
  | "agent_auto_resume_max_delay"
  | "agent_auto_resume_max_attempts"
  | "agent_auto_continue_enabled"
  | "agent_auto_continue_max_continues"
>;

/** 保存模式的协议值到本地化文案映射。 */
export const PROJECT_SAVE_MODE_LABEL_KEYS: Readonly<Record<ProjectSaveMode, LocaleKey>> = {
  MANUAL: "function_settings_page.fields.project_save_mode.options.manual",
  FIXED: "function_settings_page.fields.project_save_mode.options.fixed",
  SOURCE: "function_settings_page.fields.project_save_mode.options.source",
};

/** 译文保存模式使用独立映射，工程同目录与源文件同目录具有不同含义。 */
export const TRANSLATION_SAVE_MODE_LABEL_KEYS: Readonly<Record<TranslationSaveMode, LocaleKey>> = {
  MANUAL: "function_settings_page.fields.translation_save_mode.options.manual",
  FIXED: "function_settings_page.fields.translation_save_mode.options.fixed",
  PROJECT: "function_settings_page.fields.translation_save_mode.options.project",
};

/** 保持代理选项顺序与领域协议声明一致。 */
export const NETWORK_PROXY_MODE_OPTIONS = NETWORK_PROXY_MODES;

/** 代理模式的协议值到本地化文案映射。 */
export const NETWORK_PROXY_MODE_LABEL_KEYS: Readonly<Record<NetworkProxyMode, LocaleKey>> = {
  system: "function_settings_page.fields.network_proxy_mode.options.system",
  proxy: "function_settings_page.fields.network_proxy_mode.options.proxy",
  direct: "function_settings_page.fields.network_proxy_mode.options.direct",
};

/**
 * 从完整设置快照截取本页拥有的字段，供草稿比较与失败回滚使用。
 */
export function build_function_settings_snapshot(
  settings_snapshot: SettingsSnapshot,
): FunctionSettingsSnapshot {
  return {
    project_save_mode: settings_snapshot.project_save_mode,
    project_fixed_path: settings_snapshot.project_fixed_path,
    translation_save_mode: settings_snapshot.translation_save_mode,
    translation_fixed_path: settings_snapshot.translation_fixed_path,
    output_folder_open_on_finish: settings_snapshot.output_folder_open_on_finish,
    request_timeout: settings_snapshot.request_timeout,
    preceding_lines_threshold: settings_snapshot.preceding_lines_threshold,
    following_lines_threshold: settings_snapshot.following_lines_threshold,
    network_proxy_mode: settings_snapshot.network_proxy_mode,
    network_proxy_address: settings_snapshot.network_proxy_address,
    agent_term_lookup_enabled: settings_snapshot.agent_term_lookup_enabled,
    agent_auto_resume_enabled: settings_snapshot.agent_auto_resume_enabled,
    agent_auto_resume_initial_delay: settings_snapshot.agent_auto_resume_initial_delay,
    agent_auto_resume_max_delay: settings_snapshot.agent_auto_resume_max_delay,
    agent_auto_resume_max_attempts: settings_snapshot.agent_auto_resume_max_attempts,
    agent_auto_continue_enabled: settings_snapshot.agent_auto_continue_enabled,
    agent_auto_continue_max_continues: settings_snapshot.agent_auto_continue_max_continues,
  };
}
