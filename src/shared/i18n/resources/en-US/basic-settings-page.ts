import { zh_cn_basic_settings_page } from "../zh-CN/basic-settings-page";
import type { LocaleMessageSchema } from "../../types";

export const en_us_basic_settings_page = {
  title: "Basic Settings",
  fields: {
    source_language: {
      description: "Set the language of the input text in the current project",
    },
    target_language: {
      description: "Set the language of the output text in the current project",
    },
    project_save_mode: {
      title: "Project Save Location",
      description: "Set the save location for project files when creating a new project",
      description_fixed:
        "Set the save location for project files when creating a new project" +
        "\n" +
        "currently {PATH}",
      options: {
        manual: "Choose every time",
        fixed: "Fixed directory",
        source: "Next to source files",
      },
    },
    output_folder_open_on_finish: {
      title: "Open Output Folder When Translation File Is Generated",
      description:
        "When enabled, the output folder will be opened after the translated file is generated successfully",
    },
    request_timeout: {
      title: "Request Timeout",
      description:
        "Maximum wait for a model reply, in seconds. The task fails if no reply arrives in time.",
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
  },
  feedback: {
    request_timeout_invalid: "Request timeout must be a number within the valid range …",
    pick_directory_failed:
      "Directory selection failed. Please choose the fixed save directory again …",
    network_proxy_address_invalid: "Proxy address must be written as host:port …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_basic_settings_page>;
