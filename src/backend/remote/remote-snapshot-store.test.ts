import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RemoteSnapshotStore } from "./remote-snapshot-store";
import { sha256_text } from "./novelia-source";

const KEY = {
  origin: "https://n.novelia.cc",
  kind: "web" as const,
  provider_id: "kakuyomu",
  novel_id: "123",
};

function create_store(root: string): RemoteSnapshotStore {
  return new RemoteSnapshotStore({
    paths: { get_user_data_path: (...parts: string[]) => path.join(root, ...parts) },
    platform: "linux",
  });
}

describe("RemoteSnapshotStore", () => {
  it("按工程保存并读取上次远端文本", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-remote-snapshot-"));
    const store = create_store(root.path);
    const project_path = path.join(root.path, "demo.lg");

    const written = store.write(project_path, KEY, "# C1\ntext");
    expect(written.content_hash).toBe(sha256_text("# C1\ntext"));

    const snapshot = store.read(project_path);
    expect(snapshot).toMatchObject({
      key: KEY,
      text: "# C1\ntext",
      content_hash: written.content_hash,
    });
    expect(snapshot?.updated_at).toBe(written.updated_at);
  });

  it("文本被外部修改后按无快照处理", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-remote-snapshot-"));
    const store = create_store(root.path);
    const project_path = path.join(root.path, "demo.lg");
    store.write(project_path, KEY, "original");

    const snapshot_dir = path.join(root.path, "remote", "snapshots");
    const text_file = fs.readdirSync(snapshot_dir).find((name) => name.endsWith(".txt"));
    expect(text_file).toBeDefined();
    fs.writeFileSync(path.join(snapshot_dir, text_file!), "tampered");

    expect(store.read(project_path)).toBeNull();
  });

  it("损坏的元数据按无快照处理", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-remote-snapshot-"));
    const store = create_store(root.path);
    const project_path = path.join(root.path, "demo.lg");
    store.write(project_path, KEY, "text");

    const snapshot_dir = path.join(root.path, "remote", "snapshots");
    const metadata_file = fs.readdirSync(snapshot_dir).find((name) => name.endsWith(".json"));
    fs.writeFileSync(path.join(snapshot_dir, metadata_file!), "{broken");

    expect(store.read(project_path)).toBeNull();
  });

  it("同一工程再次写入替换旧快照", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-remote-snapshot-"));
    const store = create_store(root.path);
    const project_path = path.join(root.path, "demo.lg");
    store.write(project_path, KEY, "first");
    store.write(project_path, KEY, "second");
    expect(store.read(project_path)?.text).toBe("second");
  });

  it("清理后不再读到快照", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-remote-snapshot-"));
    const store = create_store(root.path);
    const project_path = path.join(root.path, "demo.lg");
    store.write(project_path, KEY, "text");
    store.clear(project_path);
    expect(store.read(project_path)).toBeNull();
  });

  it("不同工程互不影响", () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-remote-snapshot-"));
    const store = create_store(root.path);
    store.write(path.join(root.path, "a.lg"), KEY, "a");
    store.write(path.join(root.path, "b.lg"), KEY, "b");
    expect(store.read(path.join(root.path, "a.lg"))?.text).toBe("a");
    expect(store.read(path.join(root.path, "b.lg"))?.text).toBe("b");
  });
});
