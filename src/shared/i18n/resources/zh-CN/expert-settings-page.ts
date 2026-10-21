export const zh_cn_expert_settings_page = {
  title: "专家设置",
  fields: {
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
    preceding_lines_threshold: {
      title: "参考上文行数阈值",
      description: "每个翻译任务最多可携带的参考上文的行数，默认禁用",
    },
    clean_ruby: {
      title: "清理原文中的注音文本",
      description:
        "移除注音上标中的注音部分，仅保留正文部分，默认禁用" +
        "\n" +
        "文本中的注音上标通常不能被模型正确理解，进行清理可以提升翻译质量，支持的注音格式包括但不限于：" +
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
      title: "双语输出文件中原文与译文一致的文本只输出一次",
      description: "在字幕与电子书中，如目标文本的原文与译文一致是否只输出一次，默认启用",
    },
    write_translated_name_fields_to_file: {
      title: "将姓名字段译文写入输出文件",
      description:
        "部分 <emphasis>GalGame</emphasis> 中，姓名字段数据与立绘、配音等资源文件绑定，翻译后会报错，此时可以关闭该功能，默认启用" +
        "\n" +
        "支持格式：" +
        "\n" +
        "• RenPy 导出游戏文本（.rpy）" +
        "\n" +
        "• VNTextPatch 或 SExtractor 导出带 name 字段的游戏文本（.json）",
    },
  },
  feedback: {
    agent_auto_resume_initial_delay_invalid: "首次重试间隔必须是 1 到 3600 之间的整数秒 …",
    agent_auto_resume_max_delay_invalid: "最长重试间隔必须是 1 到 86400 之间的整数秒 …",
    agent_auto_resume_max_attempts_invalid: "最大重试次数必须是 0 到 1000 之间的整数 …",
    preceding_lines_threshold_invalid: "参考上文行数阈值必须填写为有效范围内的数字 …",
  },
} as const;
