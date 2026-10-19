export const zh_cn_basic_settings_page = {
  title: "基础设置",
  fields: {
    source_language: {
      description: "设置当前工程中输入文本的语言",
    },
    target_language: {
      description: "设置当前工程中输出文本的语言",
    },
    project_save_mode: {
      title: "工程文件保存位置",
      description: "设置新建工程时，工程文件的保存位置",
      description_fixed: "设置新建工程时，工程文件的保存位置" + "\n" + "当前为 {PATH}",
      options: {
        manual: "每次手动选择",
        fixed: "固定目录",
        source: "源文件同目录",
      },
    },
    output_folder_open_on_finish: {
      title: "生成译文文件时打开输出文件夹",
      description: "启用此功能后，将在译文文件生成成功时自动打开输出文件夹",
    },
    request_timeout: {
      title: "请求超时时间",
      description: "发起请求时等待模型回复的最长时间（秒），超时仍未收到回复，则会判断为任务失败",
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
  },
  feedback: {
    request_timeout_invalid: "请求超时时间必须填写为有效范围内的数字 …",
    pick_directory_failed: "目录选择失败 …",
    network_proxy_address_invalid: "代理地址必须填写为主机:端口 格式 …",
  },
} as const;
