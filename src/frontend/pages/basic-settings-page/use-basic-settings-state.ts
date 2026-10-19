import {
  push_error_toast,
  push_toast,
  run_modal_progress_toast,
} from "@frontend/app/feedback/desktop-toast";
import { useCallback } from "react";

import { format_project_settings_aligned_toast } from "@frontend/app/feedback/project-settings-alignment-feedback";
import { useI18n } from "@frontend/app/locale/locale-context";
import { useDesktopState, useRuntimeSnapshot } from "@frontend/app/state/use-desktop-state";
import { is_runtime_busy } from "@frontend/app/state/runtime-activity-store";
import { useSettingsEditor } from "@frontend/features/settings-editor/use-settings-editor";
import {
  REQUEST_TIMEOUT_MAX,
  REQUEST_TIMEOUT_MIN,
  build_basic_settings_snapshot,
  type BasicSettingsSnapshot,
  type NetworkProxyMode,
  type ProjectSaveMode,
} from "@frontend/pages/basic-settings-page/types";

const BASIC_SETTINGS_PENDING_FIELDS = [
  "source_language",
  "target_language",
  "project_save_mode",
  "output_folder_open_on_finish",
  "request_timeout",
  "network_proxy_mode",
  "network_proxy_address",
] as const;

type UseBasicSettingsStateResult = {
  snapshot: BasicSettingsSnapshot;
  pending_state: Record<(typeof BASIC_SETTINGS_PENDING_FIELDS)[number], boolean>;
  runtime_locked: boolean;
  update_source_language: (next_language: string) => Promise<void>;
  update_target_language: (next_language: string) => Promise<void>;
  update_project_save_mode: (next_mode: ProjectSaveMode) => Promise<void>;
  update_output_folder_open_on_finish: (next_checked: boolean) => Promise<void>;
  update_request_timeout: (next_value: number) => Promise<void>;
  update_network_proxy_mode: (next_mode: NetworkProxyMode) => Promise<void>;
  update_network_proxy_address: (next_address: string) => Promise<void>;
};

/**
 * 输入框值在页面边界收敛到后端设置允许的区间。
 */
function clamp_request_timeout(next_value: number): number {
  return Math.min(REQUEST_TIMEOUT_MAX, Math.max(REQUEST_TIMEOUT_MIN, next_value));
}

/**
 * 组合通用设置编辑器与项目预过滤对齐流程，页面不直接拥有后端设置事实。
 */
export function useBasicSettingsState(): UseBasicSettingsStateResult {
  const { project_snapshot } = useDesktopState();
  const runtime_snapshot = useRuntimeSnapshot();

  const { t } = useI18n();
  const { snapshot, pending_state, commit_update } = useSettingsEditor({
    select_snapshot: build_basic_settings_snapshot,
    pending_fields: BASIC_SETTINGS_PENDING_FIELDS,
  });
  const runtime_locked = project_snapshot.loaded && is_runtime_busy(runtime_snapshot);

  // 后端拥有设置和工程的完整保存；页面只负责输入与反馈。
  const update_language = useCallback(
    async (field: "source_language" | "target_language", next_language: string): Promise<void> => {
      if (runtime_locked || snapshot[field] === next_language) return;
      const save = async (): Promise<void> => {
        const settings = await commit_update(field, { [field]: next_language });
        if (settings !== null && project_snapshot.loaded) {
          push_toast(
            "info",
            format_project_settings_aligned_toast({
              settings,
              changed_fields: { [field]: true },
              t,
            }),
          );
        }
      };
      if (field === "source_language" && project_snapshot.loaded) {
        await run_modal_progress_toast({
          message: t("app.feedback.project_cache_loading"),
          task: save,
        });
      } else {
        await save();
      }
    },
    [commit_update, project_snapshot.loaded, runtime_locked, snapshot, t],
  );

  const update_project_save_mode = useCallback(
    async (next_mode: ProjectSaveMode): Promise<void> => {
      if (snapshot.project_save_mode === next_mode) {
        return;
      }

      if (next_mode === "FIXED") {
        try {
          const result = await window.desktopApp.pickFixedProjectDirectory(
            snapshot.project_fixed_path,
          );
          const selected_path = result.paths[0] ?? "";
          if (result.canceled || selected_path === "") {
            return;
          }

          await commit_update("project_save_mode", {
            project_save_mode: next_mode,
            project_fixed_path: selected_path,
          });
        } catch (error) {
          push_error_toast(t("basic_settings_page.feedback.pick_directory_failed"), error);
        }
        return;
      }

      await commit_update("project_save_mode", {
        project_save_mode: next_mode,
      });
    },
    [commit_update, snapshot.project_fixed_path, snapshot.project_save_mode, t],
  );

  const update_output_folder_open_on_finish = useCallback(
    async (next_checked: boolean): Promise<void> => {
      if (snapshot.output_folder_open_on_finish === next_checked) {
        return;
      }

      await commit_update("output_folder_open_on_finish", {
        output_folder_open_on_finish: next_checked,
      });
    },
    [commit_update, snapshot.output_folder_open_on_finish],
  );

  const update_request_timeout = useCallback(
    async (next_value: number): Promise<void> => {
      const normalized_timeout = clamp_request_timeout(next_value);
      if (Number.isNaN(normalized_timeout) || snapshot.request_timeout === normalized_timeout) {
        return;
      }

      await commit_update("request_timeout", {
        request_timeout: normalized_timeout,
      });
    },
    [commit_update, snapshot.request_timeout],
  );

  const update_network_proxy_mode = useCallback(
    async (next_mode: NetworkProxyMode): Promise<void> => {
      if (snapshot.network_proxy_mode === next_mode) {
        return;
      }

      await commit_update("network_proxy_mode", { network_proxy_mode: next_mode });
    },
    [commit_update, snapshot.network_proxy_mode],
  );

  const update_network_proxy_address = useCallback(
    async (next_address: string): Promise<void> => {
      if (snapshot.network_proxy_address === next_address) {
        return;
      }

      await commit_update("network_proxy_address", { network_proxy_address: next_address });
    },
    [commit_update, snapshot.network_proxy_address],
  );

  return {
    snapshot,
    pending_state,
    runtime_locked,
    update_source_language: (value) => update_language("source_language", value),
    update_target_language: (value) => update_language("target_language", value),
    update_project_save_mode,
    update_output_folder_open_on_finish,
    update_request_timeout,
    update_network_proxy_mode,
    update_network_proxy_address,
  };
}
