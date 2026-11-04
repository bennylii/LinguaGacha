import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../shared/error/app-error";
import { write_chapter_translation_with_retry } from "./chapter-translation-writer";
import type { NoveliaClient, RemoteChapterTask, RemoteWorkspaceChapter } from "./novelia-client";
import { parse_novel_url } from "./novelia-source";

const REF = parse_novel_url("https://n.novelia.cc/novel/kakuyomu/12345");
const CHAPTER: RemoteWorkspaceChapter = {
  chapter_id: "c1",
  volume_id: null,
  title: "第一章",
  translated: false,
};

function task(glossary_id: string): RemoteChapterTask {
  return {
    paragraph_jp: ["第一段"],
    old_paragraph_zh: null,
    glossary_id,
    glossary: {},
    old_glossary_id: null,
  };
}

describe("write_chapter_translation_with_retry", () => {
  it("术语表变化时刷新任务并重试一次", async () => {
    const write_chapter_translation = vi
      .fn()
      .mockRejectedValueOnce(new AppError("remote.fetch_failed"))
      .mockResolvedValueOnce(undefined);
    const read_chapter_task = vi.fn(async () => task("g2"));
    const client = {
      write_chapter_translation,
      read_chapter_task,
    } as unknown as NoveliaClient;

    await write_chapter_translation_with_retry({
      client,
      refresh_credentials: null,
      ref: REF,
      chapter: CHAPTER,
      glossary_id: "g1",
      paragraphs_zh: ["译文"],
    });

    expect(write_chapter_translation).toHaveBeenCalledTimes(2);
    expect(write_chapter_translation.mock.calls[1]?.[2]).toEqual({
      glossary_id: "g2",
      paragraphs_zh: ["译文"],
    });
    expect(read_chapter_task).toHaveBeenCalledWith(REF, CHAPTER, { sync: false }, undefined);
  });

  it("术语表未变化时保留原始写入错误", async () => {
    const original = new AppError("remote.fetch_failed");
    const write_chapter_translation = vi.fn().mockRejectedValue(original);
    const read_chapter_task = vi.fn(async () => task("g1"));
    const client = {
      write_chapter_translation,
      read_chapter_task,
    } as unknown as NoveliaClient;

    await expect(
      write_chapter_translation_with_retry({
        client,
        refresh_credentials: null,
        ref: REF,
        chapter: CHAPTER,
        glossary_id: "g1",
        paragraphs_zh: ["译文"],
      }),
    ).rejects.toBe(original);
    expect(write_chapter_translation).toHaveBeenCalledTimes(1);
  });

  it("凭据拒绝时续期后重试，不进入术语表刷新", async () => {
    const write_chapter_translation = vi
      .fn()
      .mockRejectedValueOnce(new AppError("remote.auth_rejected"))
      .mockResolvedValueOnce(undefined);
    const read_chapter_task = vi.fn();
    const refresh_credentials = vi.fn(async () => true);
    const client = {
      write_chapter_translation,
      read_chapter_task,
    } as unknown as NoveliaClient;

    await write_chapter_translation_with_retry({
      client,
      refresh_credentials,
      ref: REF,
      chapter: CHAPTER,
      glossary_id: "g1",
      paragraphs_zh: ["译文"],
    });

    expect(refresh_credentials).toHaveBeenCalledWith("https://n.novelia.cc");
    expect(write_chapter_translation).toHaveBeenCalledTimes(2);
    expect(read_chapter_task).not.toHaveBeenCalled();
  });

  it("凭据续期失败时保留认证拒绝错误且不刷新术语表", async () => {
    const original = new AppError("remote.auth_rejected");
    const write_chapter_translation = vi.fn().mockRejectedValue(original);
    const read_chapter_task = vi.fn();
    const refresh_credentials = vi.fn(async () => false);
    const client = {
      write_chapter_translation,
      read_chapter_task,
    } as unknown as NoveliaClient;

    await expect(
      write_chapter_translation_with_retry({
        client,
        refresh_credentials,
        ref: REF,
        chapter: CHAPTER,
        glossary_id: "g1",
        paragraphs_zh: ["译文"],
      }),
    ).rejects.toBe(original);

    expect(refresh_credentials).toHaveBeenCalledWith("https://n.novelia.cc");
    expect(write_chapter_translation).toHaveBeenCalledTimes(1);
    expect(read_chapter_task).not.toHaveBeenCalled();
  });

  it("取消后保留原始错误且不刷新术语表", async () => {
    const original = new AppError("remote.fetch_failed");
    const write_chapter_translation = vi.fn().mockRejectedValue(original);
    const read_chapter_task = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("停止上传"));
    const client = {
      write_chapter_translation,
      read_chapter_task,
    } as unknown as NoveliaClient;

    await expect(
      write_chapter_translation_with_retry({
        client,
        refresh_credentials: null,
        ref: REF,
        chapter: CHAPTER,
        glossary_id: "g1",
        paragraphs_zh: ["译文"],
        signal: controller.signal,
      }),
    ).rejects.toBe(original);

    expect(write_chapter_translation).toHaveBeenCalledTimes(1);
    expect(read_chapter_task).not.toHaveBeenCalled();
  });

  it("刷新后的重试失败时返回重试错误且不再循环", async () => {
    const retry_error = new AppError("remote.fetch_failed");
    const write_chapter_translation = vi
      .fn()
      .mockRejectedValueOnce(new AppError("remote.fetch_failed"))
      .mockRejectedValueOnce(retry_error);
    const read_chapter_task = vi.fn(async () => task("g2"));
    const client = {
      write_chapter_translation,
      read_chapter_task,
    } as unknown as NoveliaClient;

    await expect(
      write_chapter_translation_with_retry({
        client,
        refresh_credentials: null,
        ref: REF,
        chapter: CHAPTER,
        glossary_id: "g1",
        paragraphs_zh: ["译文"],
      }),
    ).rejects.toBe(retry_error);

    expect(write_chapter_translation).toHaveBeenCalledTimes(2);
    expect(write_chapter_translation.mock.calls[1]?.[2]).toEqual({
      glossary_id: "g2",
      paragraphs_zh: ["译文"],
    });
  });
});
