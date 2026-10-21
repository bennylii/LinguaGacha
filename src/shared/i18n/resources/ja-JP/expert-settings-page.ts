import type { zh_cn_expert_settings_page } from "../zh-CN/expert-settings-page";
import type { LocaleMessageSchema } from "../../types";
export const ja_jp_expert_settings_page = {
  title: "エキスパート設定",
  fields: {
    agent_auto_resume_enabled: {
      title: "Agent の自動再試行",
      description:
        "モデルまたは通信の一時的な障害（429、503、接続切断、タイムアウトなど）で同じラウンドを自動的に再試行します。既定で有効です" +
        "\n" +
        "400、401、403、クォータ、請求、認証エラーは再試行しません。再試行のたびに新しいモデルリクエストを送信します",
    },
    agent_auto_resume_initial_delay: {
      title: "初回再試行の間隔（秒）",
      description: "最初の自動再試行までの待ち時間です。以降は 2 倍ずつ増えます。既定は 5 秒です",
    },
    agent_auto_resume_max_delay: {
      title: "再試行間隔の上限（秒）",
      description:
        "指数バックオフの待ち時間の上限です。到達後はこの間隔で再試行を続けます。既定は 300 秒です" +
        "\n" +
        "初回再試行の間隔より小さい場合は初回間隔を使用します",
    },
    agent_auto_resume_max_attempts: {
      title: "最大再試行回数",
      description: "連続する自動再試行の上限です。0 は無制限を意味します。既定は 0 です",
    },
    preceding_lines_threshold: {
      title: "参照する前文の最大行数",
      description: "各翻訳タスクに添付できる前文の最大行数です。既定では無効です",
    },
    clean_ruby: {
      title: "原文のルビを除去",
      description:
        "ルビの読みを除去し、本文だけを残します。既定では無効です" +
        "\n" +
        "モデルはルビを正しく解釈できないことが多いため、除去すると翻訳品質の向上につながります。対応形式の例：" +
        "\n" +
        "• <ruby>漢字<rt>かんじ</rt></ruby>" +
        "\n" +
        "• (漢字/かんじ) [漢字/かんじ] |漢字[かんじ]" +
        "\n" +
        "• \\r[漢字,かんじ] \\rb[漢字,かんじ] [r_かんじ][ch_漢字] [ch_漢字]" +
        "\n" +
        '• [ruby text=かんじ] [ruby text = かんじ] [ruby text="かんじ"] [ruby text = "かんじ"]',
    },
    deduplication_in_bilingual: {
      title: "対訳ファイルで原文と訳文が同じ場合は 1 回だけ出力",
      description: "字幕と電子書籍で原文と訳文が同じ場合、1 回だけ出力します。既定で有効です",
    },
    write_translated_name_fields_to_file: {
      title: "名前フィールドの訳文を出力ファイルに書き込む",
      description:
        "一部の <emphasis>GalGame</emphasis> では名前が立ち絵や音声などのリソースと紐づいています。翻訳後にエラーが出る場合は無効にできます。既定で有効です" +
        "\n" +
        "対応形式：" +
        "\n" +
        "• RenPy から出力したゲームテキスト（.rpy）" +
        "\n" +
        "• VNTextPatch または SExtractor から出力した name フィールド付きゲームテキスト（.json）",
    },
  },
  feedback: {
    agent_auto_resume_initial_delay_invalid:
      "初回再試行の間隔は 1 から 3600 までの整数秒で入力してください …",
    agent_auto_resume_max_delay_invalid:
      "再試行間隔の上限は 1 から 86400 までの整数秒で入力してください …",
    agent_auto_resume_max_attempts_invalid:
      "最大再試行回数は 0 から 1000 までの整数で入力してください …",
    preceding_lines_threshold_invalid: "前文の最大行数には有効な範囲の数値を入力してください …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_expert_settings_page>;
