import { api_fetch } from "@frontend/app/desktop/desktop-api";
import type {
  ProjectSettingsAlignmentChangedFields,
  ProjectSettingsAlignmentSettings,
} from "@frontend/app/feedback/project-settings-alignment-feedback";

/** 打开工程响应；后端在打开事务内对齐应用级预过滤开关时附带摘要。 */
export type ProjectOpenPayload = {
  project?: { path?: string };
  settings_alignment?: {
    settings?: ProjectSettingsAlignmentSettings;
    changed?: ProjectSettingsAlignmentChangedFields;
  };
};

/**
 * 在当前窗口打开工程；预过滤对齐由后端在同一打开事务内完成。
 * 工程已由其他窗口打开时后端会聚焦那个窗口并返回 project.already_open。
 */
export async function open_project_in_current_window(args: {
  path: string;
}): Promise<ProjectOpenPayload["settings_alignment"]> {
  const payload = await api_fetch<ProjectOpenPayload>("/api/session/project/open", {
    path: args.path,
  });
  return payload.settings_alignment;
}
