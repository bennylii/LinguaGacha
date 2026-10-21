import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstanceRegistryService } from "./instance-registry-service";
import type {
  ProjectSessionChange,
  ProjectSessionSnapshot,
} from "../project/project-session-state";

type SessionStub = {
  snapshot: () => ProjectSessionSnapshot;
  subscribe_change: (listener: (change: Readonly<ProjectSessionChange>) => void) => () => void;
  set_project_path: (project_path: string) => void;
  listener_count: () => number;
};

function create_session(initial_path = ""): SessionStub {
  let snapshot: ProjectSessionSnapshot = {
    loaded: initial_path !== "",
    projectPath: initial_path,
  };
  let revision = 0;
  const listeners = new Set<(change: Readonly<ProjectSessionChange>) => void>();
  return {
    snapshot: () => snapshot,
    subscribe_change: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set_project_path: (project_path) => {
      snapshot = { loaded: project_path !== "", projectPath: project_path };
      revision += 1;
      for (const listener of listeners) listener({ ...snapshot, sessionRevision: revision });
    },
    listener_count: () => listeners.size,
  };
}

function create_service(args: {
  root: string;
  session: SessionStub;
  now?: () => number;
  focus_window?: () => Promise<void>;
  open_project_window?: (project_path: string) => Promise<void>;
}): InstanceRegistryService {
  return new InstanceRegistryService({
    paths: { get_user_data_path: (...parts) => path.join(args.root, ...parts) },
    session_state: args.session,
    app_version: "1.0.0",
    pid: 4242,
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.focus_window === undefined ? {} : { focus_window: args.focus_window }),
    ...(args.open_project_window === undefined
      ? {}
      : { open_project_window: args.open_project_window }),
  });
}

function write_instance(
  root: string,
  record: {
    pid: number;
    api_base_url: string;
    project_path?: string;
    heartbeat_at: string;
  },
): void {
  const directory = path.join(root, "instances");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${record.pid.toString()}.json`),
    JSON.stringify({
      pid: record.pid,
      api_base_url: record.api_base_url,
      app_version: "1.0.0",
      project_path: record.project_path ?? "",
      started_at: record.heartbeat_at,
      heartbeat_at: record.heartbeat_at,
    }),
  );
}

describe("InstanceRegistryService", () => {
  let root: string;
  let fixed_now: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-instances-"));
    fixed_now = Date.parse("2026-10-21T00:00:00.000Z");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("启动时写入自身注册项并在停止后删除", async () => {
    const session = create_session("E:/projects/demo.lg");
    const service = create_service({ root, session, now: () => fixed_now });

    await service.start("http://127.0.0.1:4567");
    const records = await service.list();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      pid: 4242,
      api_base_url: "http://127.0.0.1:4567",
      project_path: "E:/projects/demo.lg",
      current: true,
    });
    expect(fs.existsSync(path.join(root, "instances", "4242.json"))).toBe(true);

    await service.stop();
    expect(fs.existsSync(path.join(root, "instances", "4242.json"))).toBe(false);
    expect(session.listener_count()).toBe(0);
  });

  it("会话切换立即刷新注册项中的工程路径", async () => {
    const session = create_session();
    const service = create_service({ root, session, now: () => fixed_now });
    await service.start("http://127.0.0.1:4567");

    session.set_project_path("E:/projects/other.lg");

    const records = await service.list();
    expect(records[0]?.project_path).toBe("E:/projects/other.lg");
    await service.stop();
  });

  it("心跳过期且健康检查失败时删除注册项", async () => {
    const session = create_session();
    const service = create_service({
      root,
      session,
      now: () => fixed_now,
    });
    await service.start("http://127.0.0.1:4567");
    write_instance(root, {
      pid: 5555,
      api_base_url: "http://127.0.0.1:1",
      heartbeat_at: new Date(fixed_now - 60_000).toISOString(),
    });

    const records = await service.list();

    expect(records.map((record) => record.pid)).toEqual([4242]);
    expect(fs.existsSync(path.join(root, "instances", "5555.json"))).toBe(false);
    await service.stop();
  });

  it("心跳过期但健康检查通过时保留其他实例", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("缺少监听端口。");
    try {
      const session = create_session();
      const service = create_service({ root, session, now: () => fixed_now });
      await service.start("http://127.0.0.1:4567");
      write_instance(root, {
        pid: 5555,
        api_base_url: `http://127.0.0.1:${address.port.toString()}`,
        heartbeat_at: new Date(fixed_now - 60_000).toISOString(),
        project_path: "E:/projects/other.lg",
      });

      const records = await service.list();

      expect(records.map((record) => record.pid).sort()).toEqual([4242, 5555]);
      await service.stop();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("聚焦自身走宿主窗口端口，聚焦其他实例请求其 focus 路由", async () => {
    const focus_window = vi.fn(async () => {});
    const received: string[] = [];
    const server = http.createServer((request, response) => {
      received.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(200);
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("缺少监听端口。");
    try {
      const session = create_session();
      const service = create_service({
        root,
        session,
        now: () => fixed_now,
        focus_window,
      });
      await service.start("http://127.0.0.1:4567");
      write_instance(root, {
        pid: 5555,
        api_base_url: `http://127.0.0.1:${address.port.toString()}`,
        heartbeat_at: new Date(fixed_now).toISOString(),
      });

      await service.focus(4242);
      expect(focus_window).toHaveBeenCalledOnce();

      await service.focus(5555);
      expect(received).toEqual(["POST /api/app/focus"]);
      await service.stop();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("打开已由其他实例持有的工程时聚焦并返回 focused", async () => {
    const project_path = path.join(root, "demo.lg");
    fs.writeFileSync(project_path, "");
    const open_project_window = vi.fn(async () => {});
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("缺少监听端口。");
    try {
      const session = create_session();
      const service = create_service({
        root,
        session,
        now: () => fixed_now,
        open_project_window,
      });
      await service.start("http://127.0.0.1:4567");
      write_instance(root, {
        pid: 5555,
        api_base_url: `http://127.0.0.1:${address.port.toString()}`,
        heartbeat_at: new Date(fixed_now).toISOString(),
        project_path,
      });

      expect(await service.find_project_owner(project_path)).toMatchObject({ pid: 5555 });
      const result = await service.open(project_path);
      expect(result.action).toBe("focused");
      expect(result.instance).toMatchObject({ pid: 5555 });
      expect(open_project_window).not.toHaveBeenCalled();
      await service.stop();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("未打开的工程交给宿主新窗口端口，缺失工程直接拒绝", async () => {
    const project_path = path.join(root, "new.lg");
    fs.writeFileSync(project_path, "");
    const open_project_window = vi.fn(async () => {});
    const service = create_service({
      root,
      session: create_session(),
      now: () => fixed_now,
      open_project_window,
    });
    await service.start("http://127.0.0.1:4567");

    expect(await service.open(project_path)).toEqual({ action: "opened", instance: null });
    expect(open_project_window).toHaveBeenCalledWith(path.resolve(project_path));
    await expect(service.open(path.join(root, "missing.lg"))).rejects.toMatchObject({
      code: "project.not_found",
    });
    await service.stop();
  });

  it("损坏或非回环注册项会被删除", async () => {
    const service = create_service({ root, session: create_session(), now: () => fixed_now });
    await service.start("http://127.0.0.1:4567");
    const directory = path.join(root, "instances");
    fs.writeFileSync(path.join(directory, "7777.json"), "{broken");
    write_instance(root, {
      pid: 8888,
      api_base_url: "http://example.com:80",
      heartbeat_at: new Date(fixed_now).toISOString(),
    });

    const records = await service.list();

    expect(records.map((record) => record.pid)).toEqual([4242]);
    expect(fs.existsSync(path.join(directory, "7777.json"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "8888.json"))).toBe(false);
    await service.stop();
  });
});
