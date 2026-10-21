import { describe, expect, it } from "vitest";

import { AppError } from "../../shared/error/app-error";
import { NoveliaClient } from "./novelia-client";
import { parse_novel_url, sha256_text } from "./novelia-source";

const WEB_REF = parse_novel_url("https://n.novelia.cc/novel/kakuyomu/123");
const WENKU_REF = parse_novel_url("https://n.novelia.cc/wenku/abc");

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function create_client(handler: Handler, token: string | null = null) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const http = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      requests.push({ url: url.href, init: init ?? {} });
      return handler(url, init ?? {});
    }) as typeof globalThis.fetch,
  };
  return { client: new NoveliaClient(http, () => token), requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(body: string, content_type = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status: 200, headers: { "content-type": content_type } });
}

const WEB_METADATA = {
  titleJp: "作品",
  titleZh: "作品中文",
  introductionJp: "序",
  introductionZh: "序中",
  glossary: {},
  toc: [
    { chapterId: "c1", titleJp: "一" },
    { chapterId: null, titleJp: "分卷" },
    { chapterId: "c2", titleJp: "二" },
  ],
};

const WEB_TEXT = ["作品中文", "############", "# 一", "あ", "# 二", "い"].join("\n");

describe("NoveliaClient 网页小说", () => {
  it("读取元数据并按站点 TXT 下载整本", async () => {
    const { client, requests } = create_client((url) => {
      if (url.pathname.endsWith("/file")) {
        return new Response(null, {
          status: 302,
          headers: { location: "/files-temp/web/x.txt?filename=x.txt" },
        });
      }
      if (url.pathname.startsWith("/files-temp/")) return text(WEB_TEXT);
      return json(WEB_METADATA);
    });

    const download = await client.download(WEB_REF);

    expect(download).toMatchObject({
      filename: "作品中文.txt",
      content_hash: sha256_text(WEB_TEXT),
      chapter_count: 2,
    });
    expect(download.metadata).toMatchObject({
      title: "作品中文",
      title_jp: "作品",
      chapter_count: 2,
      volumes: [],
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/novel/kakuyomu/123",
      "/api/novel/kakuyomu/123/file",
      "/files-temp/web/x.txt",
    ]);
    const file_query = new URL(requests[1]?.url ?? "").searchParams;
    expect(file_query.get("mode")).toBe("jp");
    expect(file_query.get("type")).toBe("txt");
    expect(file_query.get("translationsMode")).toBe("parallel");
  });

  it("有 token 时携带 Bearer，没有 token 时匿名下载", async () => {
    const authorized = create_client(() => json(WEB_METADATA), "secret-token");
    await authorized.client.read_metadata(WEB_REF);
    const auth_header = new Headers(authorized.requests[0]?.init.headers).get("authorization");
    expect(auth_header).toBe("Bearer secret-token");

    const anonymous = create_client(() => json(WEB_METADATA));
    await anonymous.client.read_metadata(WEB_REF);
    expect(new Headers(anonymous.requests[0]?.init.headers).get("authorization")).toBeNull();
  });

  it("拒绝跳转到白名单之外的域名", async () => {
    const { client } = create_client((url) => {
      if (url.pathname.endsWith("/file")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/x.txt" },
        });
      }
      return json(WEB_METADATA);
    });

    await expect(client.download(WEB_REF)).rejects.toMatchObject({
      code: "remote.fetch_failed",
      message: "The novel site redirected to an unsupported host.",
    });
  });

  it("认证失败区分有无 token", async () => {
    const with_token = create_client(() => json({}, 401), "secret");
    await expect(with_token.client.read_metadata(WEB_REF)).rejects.toMatchObject({
      code: "remote.auth_rejected",
    });

    const without_token = create_client(() => json({}, 401));
    await expect(without_token.client.read_metadata(WEB_REF)).rejects.toMatchObject({
      code: "remote.auth_missing",
    });
  });

  it("拒绝 HTML 响应与超限文件", async () => {
    const html = create_client((url) => {
      if (url.pathname.startsWith("/files-temp/")) return text("<html></html>", "text/html");
      if (url.pathname.endsWith("/file")) {
        return new Response(null, {
          status: 302,
          headers: { location: "/files-temp/web/x.txt" },
        });
      }
      return json(WEB_METADATA);
    });
    await expect(html.client.download(WEB_REF)).rejects.toMatchObject({
      code: "remote.fetch_failed",
      message: "The novel site returned an HTML page instead of a novel file.",
    });

    const oversized = create_client((url) => {
      if (url.pathname.endsWith("/file")) {
        return new Response(null, {
          status: 302,
          headers: { location: "/files-temp/web/x.txt" },
        });
      }
      if (url.pathname.startsWith("/files-temp/")) {
        return new Response("x", {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": "70000000" },
        });
      }
      return json(WEB_METADATA);
    });
    await expect(oversized.client.download(WEB_REF)).rejects.toMatchObject({
      code: "remote.fetch_failed",
      message: "The novel site response exceeds the size limit.",
    });
  });

  it("响应形状不符合契约时归一为远端失败", async () => {
    const { client } = create_client(() => json({ titleJp: 1 }));
    await expect(client.read_metadata(WEB_REF)).rejects.toMatchObject({
      code: "remote.fetch_failed",
      diagnostic_context: { field: "novel.titleJp" },
    });
  });
});

describe("NoveliaClient 工作区", () => {
  const WORKSPACE = {
    titleJp: "作品",
    titleZh: "作品中文",
    introductionJp: "",
    introductionZh: null,
    glossaryUuid: "g1",
    glossary: { 术: "語" },
    toc: [
      { chapterId: "c1", titleJp: "一", glossaryUuid: null },
      { chapterId: null, titleJp: "分卷", glossaryUuid: null },
      { chapterId: "c2", titleJp: "二", glossaryUuid: "no glossary" },
    ],
  };

  it("读取工作区目录并跳过无章节的分隔项", async () => {
    const { client } = create_client(() => json(WORKSPACE), "token");
    const workspace = await client.read_workspace(WEB_REF);

    expect(workspace).toMatchObject({
      glossary_id: "g1",
      glossary: { 术: "語" },
      chapters: [
        { chapter_id: "c1", volume_id: null, title: "一", translated: false },
        { chapter_id: "c2", volume_id: null, title: "二", translated: true },
      ],
    });
  });

  it("工作区缺少 token 时在请求前失败", async () => {
    const { client, requests } = create_client(() => json(WORKSPACE));
    await expect(client.read_workspace(WEB_REF)).rejects.toMatchObject({
      code: "remote.auth_missing",
    });
    expect(requests).toHaveLength(0);
  });

  it("网页章节任务使用 POST 与 sync 参数", async () => {
    const { client, requests } = create_client(
      () =>
        json({
          paragraphJp: ["a"],
          oldParagraphZh: ["A"],
          glossaryId: "g1",
          glossary: {},
          oldGlossaryId: null,
          oldGlossary: {},
        }),
      "token",
    );
    const task = await client.read_chapter_task(
      WEB_REF,
      { chapter_id: "c1", volume_id: null, title: "一", translated: false },
      { sync: true },
    );

    expect(task).toMatchObject({ paragraph_jp: ["a"], old_paragraph_zh: ["A"] });
    expect(requests[0]?.init.method).toBe("POST");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("sync")).toBe("true");
  });

  it("上传译文并在限流后重试", async () => {
    let attempts = 0;
    const { client, requests } = create_client((url) => {
      if (url.pathname.includes("/chapter/c1")) {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ message: "busy" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "0" },
          });
        }
        return json({ jp: 1, zh: 1 });
      }
      return json({});
    }, "token");

    await client.write_chapter_translation(
      WEB_REF,
      { chapter_id: "c1", volume_id: null, title: "一", translated: false },
      { glossary_id: "g1", paragraphs_zh: ["A"] },
    );

    expect(attempts).toBe(2);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/api/novel/kakuyomu/123/translate-v2/gpt/chapter/c1",
    );
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      glossaryId: "g1",
      paragraphsZh: ["A"],
      sakuraVersion: "0.9",
    });
  });

  it("参数错误不重试", async () => {
    let attempts = 0;
    const { client } = create_client(() => {
      attempts += 1;
      return json({ message: "术语表失效" }, 400);
    }, "token");

    await expect(
      client.write_chapter_translation(
        WEB_REF,
        { chapter_id: "c1", volume_id: null, title: "一", translated: false },
        { glossary_id: "stale", paragraphs_zh: ["A"] },
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(attempts).toBe(1);
  });
});

describe("NoveliaClient 文库", () => {
  const METADATA = {
    title: "文库作品",
    titleZh: "文库中文",
    introduction: "简介",
    glossary: { 术: "語" },
    volumes: [{ title: "第一卷" }],
    volumeJp: [{ volumeId: "v1.txt", total: 2 }],
  };
  const VOLUME_TOC = {
    glossaryId: "g1",
    toc: [
      { chapterId: "001.txt", glossaryId: null },
      { chapterId: "002.txt", glossaryId: "g1" },
    ],
  };

  it("按分卷目录逐章拼装整本单文件", async () => {
    const { client, requests } = create_client((url) => {
      if (url.pathname === "/api/wenku/abc") return json(METADATA);
      if (url.pathname.endsWith("/translate-v2/gpt/v1.txt")) return json(VOLUME_TOC);
      if (url.pathname.endsWith("/chapter-task/001.txt")) {
        return json({ paragraphJp: ["甲", "", "乙"] });
      }
      if (url.pathname.endsWith("/chapter-task/002.txt")) {
        return json({ paragraphJp: ["丙"] });
      }
      return json({}, 404);
    }, "token");

    const download = await client.download(WENKU_REF);

    expect(download.chapter_count).toBe(2);
    expect(download.filename).toBe("文库中文.txt");
    expect(download.text).toContain("# 第一卷 001.txt");
    expect(download.text).toContain("# 第一卷 002.txt");
    expect(download.text).toContain("甲");
    expect(download.text).toContain("简介");
    expect(requests).toHaveLength(4);
  });

  it("工作区读取目录时不下载章节正文", async () => {
    const { client, requests } = create_client((url) => {
      if (url.pathname === "/api/wenku/abc") return json(METADATA);
      return json(VOLUME_TOC);
    }, "token");

    const workspace = await client.read_workspace(WENKU_REF);

    expect(workspace.chapters).toEqual([
      {
        chapter_id: "001.txt",
        volume_id: "v1.txt",
        title: "第一卷 001.txt",
        translated: false,
      },
      {
        chapter_id: "002.txt",
        volume_id: "v1.txt",
        title: "第一卷 002.txt",
        translated: true,
      },
    ]);
    expect(workspace).toMatchObject({ glossary_id: "g1", glossary: { 术: "語" } });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/wenku/abc",
      "/api/wenku/abc/translate-v2/gpt/v1.txt",
    ]);
  });
});
