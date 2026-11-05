import { zh_cn_function_settings_page } from "../zh-CN/function-settings-page";
import type { LocaleMessageSchema } from "../../types";

export const en_us_function_settings_page = {
  title: "Function Settings",
  fields: {
    source_language: {
      description: "Set the language of the input text",
    },
    target_language: {
      description: "Set the language of the output text",
    },
    preceding_lines_threshold: {
      title: "Preceding Context Entries",
      description:
        "Set the number of preceding text entries included as context in each task. This increases token usage. Disabled by default.",
    },
    following_lines_threshold: {
      title: "Following Context Entries",
      description:
        "Set the number of following text entries included as context in each task. This increases token usage. Disabled by default.",
    },
    request_timeout: {
      title: "Request Timeout",
      description:
        "Maximum wait for a model reply, in seconds. The task fails if no reply arrives in time.",
    },
    project_save_mode: {
      title: "Project Save Location",
      description: "Set the save location for project files when creating a new project",
      options: {
        manual: "Choose every time",
        fixed: "Fixed directory",
        source: "Next to source files",
      },
    },
    translation_save_mode: {
      title: "Translation Save Location",
      description: "Set where translation files are saved when generating translations",
      options: {
        manual: "Choose every time",
        fixed: "Fixed directory",
        project: "Next to the project file",
      },
    },
    output_folder_open_on_finish: {
      title: "Open Output Folder When Translation File Is Generated",
      description:
        "When enabled, the output folder will be opened after the translated file is generated successfully",
    },
    network_proxy_mode: {
      title: "Network Proxy",
      description:
        "Set how model requests and web search use a proxy. Changes apply to later requests immediately",
      options: {
        system: "Use system proxy",
        proxy: "Custom proxy",
        direct: "Direct connection",
      },
    },
    network_proxy_address: {
      title: "Proxy Address",
      description:
        "Address used by the custom proxy, in host:port form, for example 127.0.0.1:6789",
    },
    agent_term_lookup_enabled: {
      title: "Agent term lookup",
      description:
        "Allow Agent to query Wikipedia, Wiktionary, Jotoba, and a local JMdict common-word package. Public sources only; no project files are read or changed. Enabled by default",
    },
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
    agent_auto_continue_enabled: {
      title: "Agent Auto Continue",
      description:
        "After a round finishes successfully, the backend opens a separate judge thread to check whether the task is really done and sends a continue when it is not, disabled by default" +
        "\n" +
        "Every check costs one extra model request; a failed check or an unreadable verdict counts as done, so nothing is continued automatically",
    },
    agent_auto_continue_max_continues: {
      title: "Maximum Auto Continuations",
      description:
        "Upper bound for consecutive automatic continuations within one round; 0 means unlimited, default 10",
    },
  },
  feedback: {
    preceding_lines_threshold_invalid:
      "The preceding context entry count must be an integer from 0 to 9999999 …",
    following_lines_threshold_invalid:
      "The following context entry count must be an integer from 0 to 9999999 …",
    request_timeout_invalid: "Request timeout must be a number within the valid range …",
    pick_directory_failed:
      "Directory selection failed. Please choose the fixed save directory again …",
    network_proxy_address_invalid: "Proxy address must be written as host:port …",
    agent_auto_resume_initial_delay_invalid:
      "The initial retry delay must be a whole number of seconds from 1 to 3600 …",
    agent_auto_resume_max_delay_invalid:
      "The maximum retry delay must be a whole number of seconds from 1 to 86400 …",
    agent_auto_resume_max_attempts_invalid:
      "The maximum retry attempts must be a whole number from 0 to 1000 …",
    agent_auto_continue_max_continues_invalid:
      "The maximum auto continuations must be a whole number from 0 to 1000 …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_function_settings_page>;
