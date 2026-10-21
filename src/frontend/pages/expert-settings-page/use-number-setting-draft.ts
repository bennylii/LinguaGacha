import { useEffect, useState, type KeyboardEvent } from "react";

import { push_error_toast } from "@frontend/app/feedback/desktop-toast";
import { useI18n } from "@frontend/app/locale/locale-context";
import { parse_bounded_setting_number_draft } from "@frontend/features/settings-editor/setting-number-draft";
import type { LocaleKey } from "@shared/i18n";

type NumberSettingDraftOptions = {
  value: number;
  min: number;
  max: number;
  invalid_message: LocaleKey;
  commit: (value: number) => Promise<void>;
};

/** 专家设置页多个数值字段共用的草稿与提交入口。 */
export type NumberSettingDraft = {
  draft: string;
  invalid: boolean;
  on_change: (value: string) => void;
  on_blur: () => void;
  on_focus: () => void;
  on_key_down: (event: KeyboardEvent<HTMLInputElement>) => void;
};

/**
 * 输入期间只保留本地草稿，失焦或 Enter 时才按页面边界提交；
 * 非法草稿保留编辑态并提示，不覆盖已保存设置。
 */
export function useNumberSettingDraft(options: NumberSettingDraftOptions): NumberSettingDraft {
  const { value, min, max, invalid_message, commit } = options;
  const { t } = useI18n();
  const [draft, set_draft] = useState(() => String(value));
  const [editing, set_editing] = useState(false);
  const parsed = parse_bounded_setting_number_draft(draft, min, max);

  useEffect(() => {
    if (editing) {
      return;
    }
    set_draft(String(value));
  }, [editing, value]);

  /** 合法值交给设置入口保存，与已保存值相同时只收起草稿。 */
  async function commit_draft(): Promise<void> {
    if (parsed === null) {
      push_error_toast(t("app.feedback.save_failed"), t(invalid_message));
      set_editing(true);
      return;
    }
    if (parsed === value) {
      set_draft(String(parsed));
      set_editing(false);
      return;
    }
    await commit(parsed);
    set_editing(false);
  }

  return {
    draft,
    invalid: parsed === null,
    on_change: (next_draft) => {
      set_editing(true);
      set_draft(next_draft);
    },
    on_blur: () => {
      void commit_draft();
    },
    on_focus: () => {
      set_editing(true);
    },
    on_key_down: (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void commit_draft();
    },
  };
}
