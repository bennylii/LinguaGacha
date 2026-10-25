import { describe, expect, it } from "vitest";

import {
  DEFAULT_NETWORK_PROXY_ADDRESS,
  DEFAULT_SETTING,
  is_network_proxy_address,
  is_network_proxy_mode,
  normalize_network_proxy_address,
  normalize_setting_snapshot,
  SETTING_SNAPSHOT_SCHEMA,
  Setting,
} from "./setting";
import { Check } from "typebox/value";

describe("设置快照", () => {
  it("读取与更新的结果满足同一快照结构，并保留文本边界", () => {
    const setting = Setting.from_json({
      source_language: " en ",
      project_fixed_path: " Mixed/Path ",
      clean_ruby: "1",
      request_timeout: "45",
      recent_projects: [{ path: " p.lg ", name: "工程" }],
    });
    expect(setting.to_json()["project_fixed_path"]).toBe(" Mixed/Path ");
    expect(setting.to_json()).not.toHaveProperty("source_language"); // 语言归项目所有，旧配置字段不再保留
    expect(setting.to_snapshot()).toMatchObject({
      project_fixed_path: "Mixed/Path",
      clean_ruby: true,
      request_timeout: 45,
    });
    expect(Check(SETTING_SNAPSHOT_SCHEMA, setting.to_snapshot())).toBe(true);
    expect(
      Check(
        SETTING_SNAPSHOT_SCHEMA,
        setting.with_setting_value("request_timeout", "bad").to_snapshot(),
      ),
    ).toBe(true);
  });
  it("缺失或非法设置沿用默认值，旧语言字段不进入应用设置快照", () => {
    const snapshot = normalize_setting_snapshot({
      source_language: " en ",
      request_timeout: Infinity,
      agent_approval_mode: "unknown",
    });
    expect(snapshot).toMatchObject({
      agent_approval_mode: "manual",
      request_timeout: DEFAULT_SETTING["request_timeout"],
    });
    expect(snapshot).not.toHaveProperty("source_language");
    expect(snapshot).not.toHaveProperty("target_language");
  });

  it("代理模式与地址按领域取值归一，非法值回到默认", () => {
    expect(
      normalize_setting_snapshot({
        network_proxy_mode: "unknown",
        network_proxy_address: "socks5://127.0.0.1:1080",
      }),
    ).toMatchObject({
      network_proxy_mode: "system",
      network_proxy_address: DEFAULT_NETWORK_PROXY_ADDRESS,
    });
    expect(
      normalize_setting_snapshot({
        network_proxy_mode: "proxy",
        network_proxy_address: " 10.0.0.5:1080 ",
      }),
    ).toMatchObject({
      network_proxy_mode: "proxy",
      network_proxy_address: "10.0.0.5:1080",
    });
    expect(is_network_proxy_mode("direct")).toBe(true);
    expect(is_network_proxy_mode("DIRECT")).toBe(false);
  });

  it("代理地址只接受主机:端口，端口范围与 IPv6 方括号按规则收窄", () => {
    expect(is_network_proxy_address("127.0.0.1:6789")).toBe(true);
    expect(is_network_proxy_address("proxy.example:65535")).toBe(true);
    expect(is_network_proxy_address("[::1]:1080")).toBe(true);
    expect(is_network_proxy_address("127.0.0.1:0")).toBe(false);
    expect(is_network_proxy_address("127.0.0.1:65536")).toBe(false);
    expect(is_network_proxy_address("127.0.0.1")).toBe(false);
    expect(is_network_proxy_address("http://127.0.0.1:1080")).toBe(false);
    expect(is_network_proxy_address("")).toBe(false);
    expect(is_network_proxy_address(6789)).toBe(false);
    expect(normalize_network_proxy_address(" socks5://127.0.0.1:1080 ")).toBe(
      DEFAULT_NETWORK_PROXY_ADDRESS,
    );
  });

  it("自动重试设置按整数秒与次数边界归一，0 次保留为不限", () => {
    expect(normalize_setting_snapshot({})).toMatchObject({
      agent_auto_resume_enabled: true,
      agent_auto_resume_initial_delay: 5,
      agent_auto_resume_max_delay: 300,
      agent_auto_resume_max_attempts: 0,
    });
    expect(
      normalize_setting_snapshot({
        agent_auto_resume_enabled: "bad",
        agent_auto_resume_initial_delay: 0.8,
        agent_auto_resume_max_delay: 999_999,
        agent_auto_resume_max_attempts: -3,
      }),
    ).toMatchObject({
      agent_auto_resume_enabled: true,
      agent_auto_resume_initial_delay: 1,
      agent_auto_resume_max_delay: 86_400,
      agent_auto_resume_max_attempts: 0,
    });
    expect(
      normalize_setting_snapshot({
        agent_auto_resume_enabled: false,
        agent_auto_resume_initial_delay: 12.9,
        agent_auto_resume_max_delay: 600,
        agent_auto_resume_max_attempts: 42.7,
      }),
    ).toMatchObject({
      agent_auto_resume_enabled: false,
      agent_auto_resume_initial_delay: 12,
      agent_auto_resume_max_delay: 600,
      agent_auto_resume_max_attempts: 42,
    });
    expect(
      Setting.from_json({ agent_auto_resume_initial_delay: Infinity }).to_snapshot()
        .agent_auto_resume_initial_delay,
    ).toBe(5);
  });

  it("自动继续设置默认关闭，次数按 0 到上限归一且 0 保留为不限", () => {
    expect(normalize_setting_snapshot({})).toMatchObject({
      agent_auto_continue_enabled: false,
      agent_auto_continue_max_continues: 10,
    });
    expect(
      normalize_setting_snapshot({
        agent_auto_continue_enabled: "bad",
        agent_auto_continue_max_continues: -3,
      }),
    ).toMatchObject({
      agent_auto_continue_enabled: false,
      agent_auto_continue_max_continues: 0,
    });
    expect(
      normalize_setting_snapshot({
        agent_auto_continue_enabled: true,
        agent_auto_continue_max_continues: 1_200.7,
      }),
    ).toMatchObject({
      agent_auto_continue_enabled: true,
      agent_auto_continue_max_continues: 1_000,
    });
    expect(
      Setting.from_json({ agent_auto_continue_max_continues: Infinity }).to_snapshot()
        .agent_auto_continue_max_continues,
    ).toBe(10);
  });

  it("结果检查旧字段不会进入设置快照", () => {
    const snapshot = normalize_setting_snapshot({
      check_kana_residue: false,
      check_hangeul_residue: false,
      check_similarity: false,
    });

    expect(snapshot).not.toHaveProperty("check_kana_residue");
    expect(snapshot).not.toHaveProperty("check_hangeul_residue");
    expect(snapshot).not.toHaveProperty("check_similarity");
  });

  it("完整设置规范化模型选择并丢弃旧激活字段", () => {
    const legacy_key = ["activate", "model", "id"].join("_");
    const setting = Setting.from_json({
      [legacy_key]: "legacy",
      model_selection: {
        translation: " translation-model ",

        agent: "agent-model",
        unknown: "ignored",
      },
    }).to_json();

    expect(setting["model_selection"]).toEqual({
      translation: "translation-model",

      agent: "agent-model",
      agent_batch_translation: null,
    });
    expect(setting).not.toHaveProperty(legacy_key);
  });
});
