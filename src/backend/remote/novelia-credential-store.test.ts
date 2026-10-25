import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  NoveliaCredentialStore,
  decode_novelia_token_payload,
  extract_novelia_token,
} from "./novelia-credential-store";

function create_store(root: string): NoveliaCredentialStore {
  return new NoveliaCredentialStore({
    paths: { get_user_data_path: (...parts: string[]) => path.join(root, ...parts) },
  });
}

describe("extract_novelia_token", () => {
  it("接受原始 token 与 Bearer 前缀", () => {
    expect(extract_novelia_token("  eyJhbGciOiJIUzI1NiJ9.abc.def  ")).toBe(
      "eyJhbGciOiJIUzI1NiJ9.abc.def",
    );
    expect(extract_novelia_token("Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")).toBe(
      "eyJhbGciOiJIUzI1NiJ9.abc.def",
    );
    expect(extract_novelia_token("bearer   token-value")).toBe("token-value");
  });

  it("接受 auth-v2 与旧 auth.profile 结构", () => {
    expect(extract_novelia_token('{"token":"abc.def","user":{}}')).toBe("abc.def");
    expect(extract_novelia_token('{"profile":{"token":"legacy-token"}}')).toBe("legacy-token");
    expect(extract_novelia_token('"quoted-token"')).toBe("quoted-token");
  });

  it("从 Cookie 串提取已知名称", () => {
    expect(extract_novelia_token("theme=dark; auth-v2=eyJ0.abc.def; other=1")).toBe("eyJ0.abc.def");
    expect(extract_novelia_token(`auth-v2=${encodeURIComponent('{"token":"cookie-token"}')}`)).toBe(
      "cookie-token",
    );
  });

  it("拒绝空白、超长与无可提取字段的 JSON", () => {
    expect(extract_novelia_token("   ")).toBeNull();
    expect(extract_novelia_token("abc def")).toBeNull();
    expect(extract_novelia_token("a".repeat(8193))).toBeNull();
    expect(extract_novelia_token('{"foo":"bar"}')).toBeNull();
    expect(extract_novelia_token("{bad json")).toBeNull();
  });
});

describe("NoveliaCredentialStore", () => {
  it("按 origin 保存并在多实例间共享", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-novelia-auth-"));
    const first = create_store(root.path);
    const second = create_store(root.path);

    const status = first.save_token({
      origin: "https://n.novelia.cc/",
      raw_token: "Bearer secret-token-value",
      source: "bridge",
    });

    expect(status).toMatchObject({
      origin: "https://n.novelia.cc",
      token_tail: "alue",
      source: "bridge",
    });
    expect(second.read_token("https://n.novelia.cc")).toBe("secret-token-value");
  });

  it("规范化带尾点与端口的 origin", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-novelia-auth-"));
    const store = create_store(root.path);
    store.save_token({
      origin: "https://N.NOVELIA.CC.:8443/novel/x",
      raw_token: "token-value",
      source: "manual",
    });
    expect(store.read_token("https://n.novelia.cc:8443")).toBe("token-value");
    expect(store.list()).toEqual([
      expect.objectContaining({ origin: "https://n.novelia.cc:8443", source: "manual" }),
    ]);
  });

  it("拒绝非白名单 origin 与空 token", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-novelia-auth-"));
    const store = create_store(root.path);
    expect(() =>
      store.save_token({
        origin: "https://example.com",
        raw_token: "token",
        source: "manual",
      }),
    ).toThrow("The request parameters are invalid.");
    expect(() =>
      store.save_token({
        origin: "https://n.novelia.cc",
        raw_token: "  ",
        source: "manual",
      }),
    ).toThrow("The request parameters are invalid.");
  });

  it("损坏的文件按空凭据读取，随后可正常写入", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-novelia-auth-"));
    const store = create_store(root.path);
    fs.mkdirSync(path.join(root.path, "auth"));
    fs.writeFileSync(path.join(root.path, "auth", "novelia.json"), "{broken");
    expect(store.read_token("https://n.novelia.cc")).toBeNull();

    store.save_token({
      origin: "https://n.novelia.cc",
      raw_token: "token-value",
      source: "manual",
    });
    expect(store.read_token("https://n.novelia.cc")).toBe("token-value");
  });

  it("按 origin 清除或清空全部", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-novelia-auth-"));
    const store = create_store(root.path);
    store.save_token({
      origin: "https://n.novelia.cc",
      raw_token: "one",
      source: "manual",
    });
    store.save_token({
      origin: "https://books.fishhawk.top",
      raw_token: "two",
      source: "manual",
    });

    expect(store.clear("https://n.novelia.cc")).toHaveLength(1);
    expect(store.read_token("https://books.fishhawk.top")).toBe("two");
    expect(store.clear()).toEqual([]);
    expect(store.read_token("https://books.fishhawk.top")).toBeNull();
  });

  it("忽略文件中的非法条目", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-novelia-auth-"));
    fs.mkdirSync(path.join(root.path, "auth"));
    fs.writeFileSync(
      path.join(root.path, "auth", "novelia.json"),
      JSON.stringify({
        origins: {
          "https://n.novelia.cc": { token: "good", updated_at: "2026-01-01", source: "bridge" },
          "https://evil.example": { token: "bad" },
          "https://books.fishhawk.top": { token: "" },
        },
      }),
    );
    const store = create_store(root.path);
    expect(store.read_token("https://n.novelia.cc")).toBe("good");
    expect(store.read_token("https://evil.example")).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("登录凭据保存 Cookie 并支持过期标记与恢复", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-novelia-auth-"));
    const store = create_store(root.path);
    const status = store.save_token({
      origin: "https://n.novelia.cc",
      raw_token: "login-token-value",
      cookie: "refresh-session=abc; theme=dark",
      source: "login",
    });

    expect(status).toMatchObject({ source: "login", expired: false, token_tail: "alue" });
    expect(store.read_credential("https://n.novelia.cc")).toEqual({
      token: "login-token-value",
      cookie: "refresh-session=abc; theme=dark",
    });

    store.mark_expired("https://n.novelia.cc", true);
    expect(store.list()[0]).toMatchObject({ expired: true });
    // 重复标记不产生多余写入，读取结果保持稳定。
    store.mark_expired("https://n.novelia.cc", true);
    expect(store.read_credential("https://n.novelia.cc")).toMatchObject({
      token: "login-token-value",
    });

    store.save_token({
      origin: "https://n.novelia.cc",
      raw_token: "login-token-value",
      source: "login",
    });
    expect(store.list()[0]).toMatchObject({ expired: false });
    // 未提供 cookie 的重新保存会清掉旧 Cookie 串。
    expect(store.read_credential("https://n.novelia.cc")).toEqual({
      token: "login-token-value",
      cookie: "",
    });
  });

  it("手动凭据没有 Cookie 且不受过期标记影响", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-novelia-auth-"));
    const store = create_store(root.path);
    store.save_token({
      origin: "https://n.novelia.cc",
      raw_token: "manual-token",
      source: "manual",
    });
    expect(store.read_credential("https://n.novelia.cc")).toEqual({
      token: "manual-token",
      cookie: "",
    });
    expect(store.list()[0]).toMatchObject({ expired: false });
  });
});

describe("decode_novelia_token_payload", () => {
  /** 构造一个仅用于解码测试的最小 JWT。 */
  function encode_payload(payload: Record<string, unknown>): string {
    return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(
      ".",
    );
  }

  it("解出 sub、iat 与 exp", () => {
    const payload = decode_novelia_token_payload(
      encode_payload({ sub: "user", iat: 1_700_000_000, exp: 1_700_007_200, role: "Member" }),
    );
    expect(payload).toEqual({ sub: "user", iat: 1_700_000_000, exp: 1_700_007_200 });
  });

  it("结构或字段不完整时返回 null", () => {
    expect(decode_novelia_token_payload("not-a-jwt")).toBeNull();
    expect(decode_novelia_token_payload("a.b.c")).toBeNull();
    expect(
      decode_novelia_token_payload(encode_payload({ sub: "user", iat: "x", exp: 1 })),
    ).toBeNull();
    expect(decode_novelia_token_payload(encode_payload({ iat: 1, exp: 2 }))).toBeNull();
  });
});
