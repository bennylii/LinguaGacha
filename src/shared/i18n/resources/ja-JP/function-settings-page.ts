import type { zh_cn_function_settings_page } from "../zh-CN/function-settings-page";
import type { LocaleMessageSchema } from "../../types";
export const ja_jp_function_settings_page = {
  title: "機能設定",
  fields: {
    source_language: {
      description: "入力テキストの言語を設定します",
    },
    target_language: {
      description: "出力テキストの言語を設定します",
    },
    preceding_lines_threshold: {
      title: "参照する前文の項目数",
      description:
        "各タスクに含める参考前文の項目数を設定します。トークン消費量が増えます。既定では無効です。",
    },
    following_lines_threshold: {
      title: "参照する後文の項目数",
      description:
        "各タスクに含める参考後文の項目数を設定します。トークン消費量が増えます。既定では無効です。",
    },
    request_timeout: {
      title: "リクエストのタイムアウト",
      description:
        "モデルの応答を待つ最長時間（秒）です。時間内に応答がない場合、タスクは失敗となります",
    },
    project_save_mode: {
      title: "プロジェクトファイルの保存先",
      description: "新しいプロジェクトを作成するときのプロジェクトファイルの保存先を設定します",
      options: {
        manual: "毎回選択",
        fixed: "固定フォルダー",
        source: "元ファイルと同じフォルダー",
      },
    },
    translation_save_mode: {
      title: "訳文ファイルの保存先",
      description: "訳文を生成するときの訳文ファイルの保存先を設定します",
      options: {
        manual: "毎回選択",
        fixed: "固定フォルダー",
        project: "プロジェクトファイルと同じフォルダー",
      },
    },
    output_folder_open_on_finish: {
      title: "訳文ファイルの生成後に出力フォルダーを開く",
      description: "訳文ファイルを生成できたときに、出力フォルダーを自動で開きます",
    },
    network_proxy_mode: {
      title: "ネットワークプロキシ",
      description:
        "モデルへのリクエストとウェブ検索でプロキシを使う方法を設定します。変更は以降のリクエストにすぐ反映されます",
      options: {
        system: "システムのプロキシに従う",
        proxy: "プロキシを指定",
        direct: "直接接続",
      },
    },
    network_proxy_address: {
      title: "プロキシアドレス",
      description:
        "プロキシを指定する場合に使うアドレスです。ホスト:ポート の形式で、例: 127.0.0.1:6789",
    },
    agent_term_lookup_enabled: {
      title: "Agent の用語検索",
      description:
        "Agent が Wikipedia、Wiktionary、Jotoba、ローカルの JMdict 常用語パッケージを検索できるようにします。公開ソースのみを参照し、プロジェクトは読み取りも変更もしません。既定で有効です",
    },
    agent_auto_resume_enabled: {
      title: "Agent の自動リトライ",
      description:
        "モデルや通信の一時的な障害（429、503、接続切断、タイムアウトなど）で同じラウンドを自動的にリトライします。既定で有効です" +
        "\n" +
        "400、401、403、クォータ、請求、認証エラーはリトライしません。リトライごとに新しいモデルリクエストを送信します",
    },
    agent_auto_resume_initial_delay: {
      title: "初回リトライ間隔（秒）",
      description: "1 回目の自動リトライ前の待ち時間です。以降は 2 倍ずつ増えます。既定は 5 秒です",
    },
    agent_auto_resume_max_delay: {
      title: "最大リトライ間隔（秒）",
      description:
        "指数バックオフの上限です。到達後はその間隔でリトライを続けます。既定は 300 秒です" +
        "\n" +
        "初回リトライ間隔より小さい場合は初回リトライ間隔で実行します",
    },
    agent_auto_resume_max_attempts: {
      title: "最大リトライ回数",
      description: "連続する自動リトライの上限です。0 で無制限になります。既定は 0 です",
    },
    agent_auto_continue_enabled: {
      title: "Agent の自動継続",
      description:
        "1 ラウンドが正常に終了した後、バックエンドが独立した判定スレッドでタスクが本当に完了したかを確認し、未完了なら自動で継続を送信します。既定では無効です" +
        "\n" +
        "判定のたびに追加のモデルリクエストを 1 回送信します。判定に失敗した場合や結論を解釈できない場合は完了として扱い、自動継続は行いません",
    },
    agent_auto_continue_max_continues: {
      title: "最大自動継続回数",
      description:
        "1 ラウンド内で連続して自動継続する回数の上限です。0 で無制限になります。既定は 10 です",
    },
  },
  feedback: {
    preceding_lines_threshold_invalid:
      "参照する前文の項目数は 0 から 9999999 の整数で入力してください …",
    following_lines_threshold_invalid:
      "参照する後文の項目数は 0 から 9999999 の整数で入力してください …",
    request_timeout_invalid: "タイムアウトには有効な範囲の数値を入力してください …",
    pick_directory_failed: "フォルダーを選択できませんでした。固定の保存先を選び直してください …",
    network_proxy_address_invalid: "プロキシアドレスは ホスト:ポート の形式で入力してください …",
    agent_auto_resume_initial_delay_invalid:
      "初回リトライ間隔は 1 から 3600 の整数秒で入力してください …",
    agent_auto_resume_max_delay_invalid:
      "最大リトライ間隔は 1 から 86400 の整数秒で入力してください …",
    agent_auto_resume_max_attempts_invalid:
      "最大リトライ回数は 0 から 1000 の整数で入力してください …",
    agent_auto_continue_max_continues_invalid:
      "最大自動継続回数は 0 から 1000 の整数で入力してください …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_function_settings_page>;
