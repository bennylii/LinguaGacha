import { zh_cn_expert_settings_page } from "../zh-CN/expert-settings-page";
import type { LocaleMessageSchema } from "../../types";

export const en_us_expert_settings_page = {
  title: "Expert Settings",
  fields: {
    agent_auto_resume_enabled: {
      title: "Agent Auto Retry",
      description:
        "Automatically retry the same round on transient model or transport failures (429, 503, connection errors, timeouts), enabled by default" +
        "\n" +
        "400, 401, 403, quota, billing, and authentication errors are never retried; every retry starts a new model request",
    },
    agent_auto_resume_initial_delay: {
      title: "Initial Retry Delay (seconds)",
      description:
        "Wait before the first automatic retry; each later wait doubles, default 5 seconds",
    },
    agent_auto_resume_max_delay: {
      title: "Maximum Retry Delay (seconds)",
      description:
        "Upper bound for the exponential backoff; retries continue at this interval once reached, default 300 seconds" +
        "\n" +
        "When smaller than the initial delay, the initial delay is used",
    },
    agent_auto_resume_max_attempts: {
      title: "Maximum Retry Attempts",
      description: "Upper bound for consecutive automatic retries; 0 means unlimited, default 0",
    },
    preceding_lines_threshold: {
      title: "Preceding Lines Threshold",
      description:
        "Maximum number of preceding lines to include as context for each translation task, disabled by default",
    },
    clean_ruby: {
      title: "Clean Ruby Text",
      description:
        "Remove ruby readings, keep base text (off by default). Models often misread ruby; removal may improve translation. Supported formats include:" +
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
      title: "Output Only Once if Source and Target are Identical in Bilingual Output Files",
      description:
        "In subtitles or e-books, whether to output text only once if the source and target text are identical, enabled by default",
    },
    write_translated_name_fields_to_file: {
      title: "Write Translated Name Fields to the Output File",
      description:
        "Some <emphasis>GalGame</emphasis> names link to image or voice files. Disable name translation if it causes errors (on by default)." +
        "\n" +
        "Supported formats:" +
        "\n" +
        "• RenPy exported game text (.rpy)" +
        "\n" +
        "• VNTextPatch or SExtractor exported game text with name fields (.json)",
    },
  },
  feedback: {
    agent_auto_resume_initial_delay_invalid:
      "The initial retry delay must be a whole number of seconds from 1 to 3600 …",
    agent_auto_resume_max_delay_invalid:
      "The maximum retry delay must be a whole number of seconds from 1 to 86400 …",
    agent_auto_resume_max_attempts_invalid:
      "The maximum retry attempts must be a whole number from 0 to 1000 …",
    preceding_lines_threshold_invalid:
      "Preceding lines threshold must be a number within the valid range …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_expert_settings_page>;
