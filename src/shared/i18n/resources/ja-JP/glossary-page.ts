import type { zh_cn_glossary_page } from "../zh-CN/glossary-page";
import type { LocaleMessageSchema } from "../../types";
export const ja_jp_glossary_page = {
  title: "用語集",
  toggle: {
    tooltip:
      "プロンプトに用語集を組み込み、訳語の統一や人物属性の修正など、モデルの翻訳を補助します",
  },
  fields: {
    translation: "訳文",
    info: "説明",
    evidence: "調査根拠（翻訳プロンプトには含めません）",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_glossary_page>;
