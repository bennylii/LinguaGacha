import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NoveliaAuthBridge } from "./novelia-auth-bridge";
import { NoveliaCredentialStore } from "./novelia-credential-store";

let root_path = "";
let store: NoveliaCredentialStore;
let bridge: NoveliaAuthBridge;
let occupied: Server | null = null;

function create_bridge(port_start = 0, port_end = 0): NoveliaAuthBridge {
  return new NoveliaAuthBridge({
    credentials: store,
    port_start,
    port_end,
  });
}

async function listen_on_ephemeral(): Promise<{ server: Server; port: number }> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({ server, port: address.port });
    });
  });
}

beforeEach(() => {
  root_path = fs.mkdtempSync(path.join(os.tmpdir(), "lg-novelia-bridge-"));
  store = new NoveliaCredentialStore({
    paths: { get_user_data_path: (...parts: string[]) => path.join(root_path, ...parts) },
  });
  bridge = create_bridge();
});

afterEach(async () => {
  await bridge.stop();
  if (occupied !== null) {
    await new Promise<void>((resolve) => occupied?.close(() => resolve()));
    occupied = null;
  }
  fs.rmSync(root_path, { recursive: true, force: true });
});

describe("NoveliaAuthBridge", () => {
  it("启动后报告回环地址", async () => {
    await bridge.start();
    const status = bridge.get_status();
    expect(status.running).toBe(true);
    expect(status.address).toBe(`http://127.0.0.1:${status.port}`);
    expect(status.error).toBeNull();

    const response = await fetch(`${status.address}/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, running: true, origins: [] });
  });

  it("接收 userscript 的凭据推送且不回显 token", async () => {
    await bridge.start();
    const base = bridge.get_status().address;
    const response = await fetch(`${base}/auth`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://n.novelia.cc",
      },
      body: JSON.stringify({
        token: "eyJhbGciOiJIUzI1NiJ9.abc.def",
        workers: [{ id: 1 }, { id: 2 }],
        origin: "https://n.novelia.cc",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      origin: "https://n.novelia.cc",
      token_tail: ".def",
      workers: 2,
    });
    expect(JSON.stringify(payload)).not.toContain("eyJhbGciOiJIUzI1NiJ9.abc.def");
    expect(store.read_token("https://n.novelia.cc")).toBe("eyJhbGciOiJIUzI1NiJ9.abc.def");
  });

  it("拒绝非白名单 Origin 且不写入凭据", async () => {
    await bridge.start();
    const base = bridge.get_status().address;
    const response = await fetch(`${base}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ token: "abc", origin: "https://evil.example" }),
    });
    expect(response.status).toBe(403);
    expect(store.list()).toEqual([]);
  });

  it("只对白名单 Origin 响应预检", async () => {
    await bridge.start();
    const base = bridge.get_status().address;

    const allowed = await fetch(`${base}/auth`, {
      method: "OPTIONS",
      headers: { origin: "https://n.novelia.cc", "access-control-request-method": "POST" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://n.novelia.cc");
    expect(allowed.headers.get("access-control-allow-methods")).toContain("POST");

    const denied = await fetch(`${base}/auth`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(denied.status).toBe(403);
  });

  it("拒绝超限或损坏的请求体", async () => {
    await bridge.start();
    const base = bridge.get_status().address;

    const oversized = await fetch(`${base}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://n.novelia.cc" },
      body: JSON.stringify({
        origin: "https://n.novelia.cc",
        token: "a".repeat(70 * 1024),
      }),
    });
    expect(oversized.status).toBe(400);

    const broken = await fetch(`${base}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://n.novelia.cc" },
      body: "{broken",
    });
    expect(broken.status).toBe(400);
  });

  it("缺少 token 时保留已有凭据", async () => {
    store.save_token({
      origin: "https://n.novelia.cc",
      raw_token: "existing-token",
      source: "manual",
    });
    await bridge.start();
    const base = bridge.get_status().address;

    const response = await fetch(`${base}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://n.novelia.cc" },
      body: JSON.stringify({ origin: "https://n.novelia.cc" }),
    });

    expect(response.status).toBe(400);
    expect(store.read_token("https://n.novelia.cc")).toBe("existing-token");
  });

  it("端口被占用时顺延到下一个", async () => {
    const taken = await listen_on_ephemeral();
    occupied = taken.server;
    bridge = create_bridge(taken.port, taken.port + 20);
    await bridge.start();

    expect(bridge.get_status().running).toBe(true);
    expect(bridge.get_status().port).not.toBe(taken.port);
  });

  it("重复启动不会更换端口，停止后释放状态", async () => {
    await bridge.start();
    const port = bridge.get_status().port;
    await bridge.start();
    expect(bridge.get_status().port).toBe(port);

    await bridge.stop();
    expect(bridge.get_status()).toMatchObject({ running: false, port: null, address: null });
  });
});
