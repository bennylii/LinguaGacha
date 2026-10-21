import { api_fetch } from "@frontend/app/desktop/desktop-api";
import type { SettingsSnapshot } from "@frontend/app/state/desktop-state-context";
import type {
  ProjectSettingsAlignmentChangedFields,
  ProjectSettingsAlignmentSettings,
} from "@frontend/app/feedback/project-settings-alignment-feedback";

type OpenPreviewPayload = {
  preview?: {
    action?: string;
    section_revisions?: Record<string, unknown> | null;
    changed?: ProjectSettingsAlignmentChangedFields;
  };
};

export type OpenProjectInWindowResult = {
  aligned: boolean;
  changed_fields: ProjectSettingsAlignmentChangedFields;
};

/** 设置对齐预演与工程打开共用同一镜像字段，避免页面各自拼装。 */
export function build_project_prefilter_settings(
  settings: SettingsSnapshot,
): ProjectSettingsAlignmentSettings {
  return {
    source_language: settings.source_language,
    target_language: settings.target_language,
    mtool_optimizer_enable: settings.mtool_optimizer_enable,
    skip_duplicate_source_text_enable: settings.skip_duplicate_source_text_enable,
  };
}

/**
 * 在当前窗口打开工程：先按当前设置对齐，再加载会话。
 * 工程已由其他窗口打开时后端会聚焦那个窗口并返回 project.already_open。
 */
export async function open_project_in_current_window(args: {
  path: string;
  settings: SettingsSnapshot;
}): Promise<OpenProjectInWindowResult> {
  const alignment_payload = await api_fetch<OpenPreviewPayload>(
    "/api/session/project/open-preview",
    {
      path: args.path,
    },
  );
  const alignment_preview = alignment_payload.preview ?? {};
  const alignment_action = String(alignment_preview.action ?? "load");
  const alignment_settings = build_project_prefilter_settings(args.settings);
  const changed_fields = alignment_preview.changed ?? {};
  let aligned = false;

  if (alignment_action === "settings_only") {
    await api_fetch("/api/workbench/settings-alignment/apply", {
      path: args.path,
      mode: "settings_only",
      project_settings: alignment_settings,
    });
    aligned = true;
  } else if (alignment_action === "prefiltered_items") {
    const section_revisions = alignment_preview.section_revisions ?? {};
    await api_fetch("/api/workbench/settings-alignment/apply", {
      path: args.path,
      mode: "prefiltered_items",
      project_settings: alignment_settings,
      expected_section_revisions: {
        items: Number(section_revisions.items ?? 0),
      },
    });
    aligned = true;
  }

  await api_fetch("/api/session/project/open", { path: args.path });
  return { aligned, changed_fields };
}
