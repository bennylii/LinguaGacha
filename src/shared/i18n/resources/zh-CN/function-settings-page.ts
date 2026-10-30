export const zh_cn_function_settings_page = {
  title: "功能设置",
  fields: {
    source_language: {
      description: "设置输入文本的语言",
    },
    target_language: {
      description: "设置输出文本的语言",
    },
    preceding_lines_threshold: {
      title: "参考前文条目数",
      description: "设置每个任务携带的参考前文条目数，会增加 Token 消耗，默认禁用",
    },
    following_lines_threshold: {
      title: "参考后文条目数",
      description: "设置每个任务携带的参考后文条目数，会增加 Token 消耗，默认禁用",
    },
    request_timeout: {
      title: "请求超时时间",
      description: "发起请求时等待模型回复的最长时间（秒），超时仍未收到回复，则会判断为任务失败",
    },
    project_save_mode: {
      title: "工程文件保存位置",
      description: "设置新建工程时工程文件的保存位置",
      options: {
        manual: "每次手动选择",
        fixed: "固定目录",
        source: "源文件同目录",
      },
    },
    translation_save_mode: {
      title: "译文文件保存位置",
      description: "设置生成译文时译文文件的保存位置",
      options: { manual: "每次手动选择", fixed: "固定目录", project: "工程文件同目录" },
    },
    output_folder_open_on_finish: {
      title: "生成译文文件时打开输出文件夹",
      description: "启用此功能后，将在译文文件生成成功时自动打开输出文件夹",
    },
    network_proxy_mode: {
      title: "网络代理",
      description: "设置模型请求与联网搜索使用的代理方式，修改后对后续请求立即生效",
      options: {
        system: "跟随系统代理",
        proxy: "自定义代理",
        direct: "直连",
      },
    },
    network_proxy_address: {
      title: "代理地址",
      description: "自定义代理使用的地址，格式为主机:端口，例如 127.0.0.1:6789",
    },
    agent_term_lookup_enabled: {
      title: "Agent 术语查询",
      description:
        "允许 Agent 查询 Wikipedia、Wiktionary、Jotoba 和本地 JMdict 常用词包；仅访问公开来源，不读取或修改工程，默认启用",
    },
    agent_auto_resume_enabled: {
      title: "Agent 自动重试",
      description:
        "模型或传输出现瞬时故障（429、503、连接中断、超时等）时自动重试同一轮次，默认启用" +
        "\n" +
        "400、401、403、配额、账单和鉴权错误不会重试；每次重试都会发起新的模型请求",
    },
    agent_auto_resume_initial_delay: {
      title: "首次重试间隔（秒）",
      description: "第 1 次自动重试前的等待时间，之后每次按 2 倍增长，默认 5 秒",
    },
    agent_auto_resume_max_delay: {
      title: "最长重试间隔（秒）",
      description:
        "指数退避的等待上限，达到后按该间隔持续重试，默认 300 秒" +
        "\n" +
        "小于首次重试间隔时按首次重试间隔执行",
    },
    agent_auto_resume_max_attempts: {
      title: "最大重试次数",
      description: "连续自动重试的次数上限，填 0 表示不限次数，默认 0",
    },
    agent_auto_continue_enabled: {
      title: "Agent 自动继续",
      description:
        "一轮任务成功结束后，由后端开启独立的判定线程检查任务是否真的做完，未做完时自动发出继续，默认禁用" +
        "\n" +
        "每次判定都会额外发起一次模型请求；判定失败或结论无法解析时按已完成处理，不会自动继续",
    },
    agent_auto_continue_max_continues: {
      title: "最大自动继续次数",
      description: "单轮任务内连续自动继续的次数上限，填 0 表示不限次数，默认 10",
    },
  },
  feedback: {
    preceding_lines_threshold_invalid: "参考前文条目数必须填写为 0 至 9999999 的整数 …",
    following_lines_threshold_invalid: "参考后文条目数必须填写为 0 至 9999999 的整数 …",
    request_timeout_invalid: "请求超时时间必须填写为有效范围内的数字 …",
    pick_directory_failed: "目录选择失败 …",
    network_proxy_address_invalid: "代理地址必须填写为主机:端口 格式 …",
    agent_auto_resume_initial_delay_invalid: "首次重试间隔必须是 1 到 3600 之间的整数秒 …",
    agent_auto_resume_max_delay_invalid: "最长重试间隔必须是 1 到 86400 之间的整数秒 …",
    agent_auto_resume_max_attempts_invalid: "最大重试次数必须是 0 到 1000 之间的整数 …",
    agent_auto_continue_max_continues_invalid: "最大自动继续次数必须是 0 到 1000 之间的整数 …",
  },
} as const;
