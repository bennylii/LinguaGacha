import { type JSX, useCallback, useState } from "react";
import { ChevronsUpDown, FolderKanban } from "lucide-react";

import { api_fetch } from "@frontend/app/desktop/desktop-api";
import { push_error_toast } from "@frontend/app/feedback/desktop-toast";
import { useI18n } from "@frontend/app/locale/locale-context";
import {
  AppDropdownMenu,
  AppDropdownMenuContent,
  AppDropdownMenuGroup,
  AppDropdownMenuItem,
  AppDropdownMenuLabel,
  AppDropdownMenuSeparator,
  AppDropdownMenuSub,
  AppDropdownMenuSubContent,
  AppDropdownMenuSubTrigger,
  AppDropdownMenuTrigger,
} from "@frontend/widgets/app-dropdown-menu";

type AppInstance = {
  pid: number;
  api_base_url: string;
  app_version: string;
  project_path: string;
  started_at: string;
  heartbeat_at: string;
  current: boolean;
};

export type ProjectSwitcherRecentProject = {
  path: string;
  name: string;
};

type ProjectSwitcherProps = {
  current_project_path: string;
  recent_projects: readonly ProjectSwitcherRecentProject[];
  on_open_in_current_window: (project_path: string) => Promise<void>;
};

/** 从 .lg 路径取展示名，工程主页等无路径场景由调用文案兜底。 */
function project_display_name(project_path: string): string {
  const file_name = project_path.split(/[\\/]+/u).at(-1) ?? project_path;
  return file_name.replace(/\.[^.]*$/u, "") || project_path;
}

/**
 * 顶栏工程切换器：列出其他运行窗口与最近工程。
 * 打开已由其他窗口持有的工程时，后端会改为聚焦该窗口，避免同一 .lg 被两个进程写入。
 */
export function ProjectSwitcher(props: ProjectSwitcherProps): JSX.Element {
  const { t } = useI18n();
  const [instances, set_instances] = useState<AppInstance[]>([]);
  const [is_loading_instances, set_is_loading_instances] = useState(false);
  const current_project_name =
    props.current_project_path === ""
      ? t("app.project_switcher.no_project")
      : project_display_name(props.current_project_path);
  const other_instances = instances.filter(
    (instance) => !instance.current && instance.project_path !== props.current_project_path,
  );
  const recent_projects = props.recent_projects.filter(
    (project) => project.path !== props.current_project_path,
  );

  const refresh_instances = useCallback(async (): Promise<void> => {
    set_is_loading_instances(true);
    try {
      const payload = await api_fetch<{ instances?: unknown }>("/api/app/instances", {});
      set_instances(normalize_instances(payload.instances));
    } catch (error) {
      push_error_toast(t("app.project_switcher.load_failed"), error);
    } finally {
      set_is_loading_instances(false);
    }
  }, [t]);

  async function focus_instance(pid: number): Promise<void> {
    try {
      await api_fetch("/api/app/instances/focus", { pid });
    } catch (error) {
      push_error_toast(t("app.project_switcher.focus_failed"), error);
    }
  }

  async function open_in_new_window(project_path: string): Promise<void> {
    try {
      await api_fetch("/api/app/instances/open", { path: project_path });
    } catch (error) {
      push_error_toast(t("app.project_switcher.open_failed"), error);
    }
  }

  async function open_in_current_window(project_path: string): Promise<void> {
    try {
      await props.on_open_in_current_window(project_path);
    } catch (error) {
      push_error_toast(t("app.project_switcher.open_failed"), error);
    }
  }

  return (
    <AppDropdownMenu
      onOpenChange={(open) => {
        if (open) void refresh_instances();
      }}
    >
      <AppDropdownMenuTrigger
        render={
          <button
            type="button"
            className="topbar__project-trigger"
            aria-label={t("app.project_switcher.label")}
            title={props.current_project_path}
          >
            <FolderKanban size={16} aria-hidden="true" />
            <span className="topbar__project-name">{current_project_name}</span>
            <ChevronsUpDown size={14} aria-hidden="true" />
          </button>
        }
      />
      <AppDropdownMenuContent
        align="start"
        matchTriggerWidth={false}
        className="topbar__project-menu"
      >
        <AppDropdownMenuGroup>
          <AppDropdownMenuLabel>{t("app.project_switcher.current")}</AppDropdownMenuLabel>
          <AppDropdownMenuItem disabled>
            <span className="topbar__project-item">
              <span className="topbar__project-item-name">{current_project_name}</span>
              {props.current_project_path === "" ? null : (
                <span className="topbar__project-item-path">{props.current_project_path}</span>
              )}
            </span>
          </AppDropdownMenuItem>
        </AppDropdownMenuGroup>

        <AppDropdownMenuSeparator />
        <AppDropdownMenuGroup>
          <AppDropdownMenuLabel>{t("app.project_switcher.instances")}</AppDropdownMenuLabel>
          {other_instances.length === 0 ? (
            <AppDropdownMenuItem disabled>
              {is_loading_instances
                ? t("app.project_switcher.loading")
                : t("app.project_switcher.no_instances")}
            </AppDropdownMenuItem>
          ) : (
            other_instances.map((instance) => {
              const instance_name =
                instance.project_path === ""
                  ? t("app.project_switcher.no_project")
                  : project_display_name(instance.project_path);
              return (
                <AppDropdownMenuItem
                  key={instance.pid}
                  onClick={() => {
                    void focus_instance(instance.pid);
                  }}
                >
                  <span className="topbar__project-item">
                    <span className="topbar__project-item-name">{instance_name}</span>
                    <span className="topbar__project-item-path">{instance.project_path}</span>
                  </span>
                </AppDropdownMenuItem>
              );
            })
          )}
        </AppDropdownMenuGroup>

        <AppDropdownMenuSeparator />
        <AppDropdownMenuGroup>
          <AppDropdownMenuLabel>{t("app.project_switcher.recent")}</AppDropdownMenuLabel>
          {recent_projects.length === 0 ? (
            <AppDropdownMenuItem disabled>
              {t("app.project_switcher.empty_recent")}
            </AppDropdownMenuItem>
          ) : (
            recent_projects.map((project) => (
              <AppDropdownMenuSub key={project.path}>
                <AppDropdownMenuSubTrigger>
                  <span className="topbar__project-item">
                    <span className="topbar__project-item-name">{project.name}</span>
                    <span className="topbar__project-item-path">{project.path}</span>
                  </span>
                </AppDropdownMenuSubTrigger>
                <AppDropdownMenuSubContent>
                  <AppDropdownMenuItem
                    onClick={() => {
                      void open_in_current_window(project.path);
                    }}
                  >
                    {t("app.project_switcher.open_current")}
                  </AppDropdownMenuItem>
                  <AppDropdownMenuItem
                    onClick={() => {
                      void open_in_new_window(project.path);
                    }}
                  >
                    {t("app.project_switcher.open_new")}
                  </AppDropdownMenuItem>
                </AppDropdownMenuSubContent>
              </AppDropdownMenuSub>
            ))
          )}
        </AppDropdownMenuGroup>
      </AppDropdownMenuContent>
    </AppDropdownMenu>
  );
}

/** 注册表响应只接受完整字段，损坏项不会阻断其他窗口。 */
function normalize_instances(value: unknown): AppInstance[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AppInstance => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as Record<string, unknown>;
    return (
      typeof record["pid"] === "number" &&
      typeof record["api_base_url"] === "string" &&
      typeof record["project_path"] === "string" &&
      typeof record["current"] === "boolean"
    );
  });
}
