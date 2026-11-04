import { AppError } from "../../shared/error/app-error";
import { call_with_credential_refresh } from "./credential-refresh";
import type { NoveliaClient, RemoteWorkspaceChapter } from "./novelia-client";
import type { RemoteNovelRef } from "./novelia-source";

export interface ChapterTranslationWriteRequest {
  client: NoveliaClient;
  refresh_credentials: ((origin: string) => Promise<boolean>) | null;
  ref: RemoteNovelRef;
  chapter: RemoteWorkspaceChapter;
  glossary_id: string;
  paragraphs_zh: readonly string[];
  signal?: AbortSignal | undefined;
}

/**
 * 站点只接受整章译文；术语表在取任务与上传之间变化时刷新一次任务并重试。
 * 行数、空译文与本地条目映射由调用方校验，本函数只负责站点写入与重试。
 */
export async function write_chapter_translation_with_retry(
  args: ChapterTranslationWriteRequest,
): Promise<void> {
  try {
    await call_with_credential_refresh(args.refresh_credentials, args.ref.origin, () =>
      args.client.write_chapter_translation(
        args.ref,
        args.chapter,
        { glossary_id: args.glossary_id, paragraphs_zh: [...args.paragraphs_zh] },
        args.signal,
      ),
    );
  } catch (error) {
    if (args.signal?.aborted === true) throw error;
    // 凭据续期失败时保持认证错误，不能再用读取任务掩盖原始失败原因。
    if (error instanceof AppError && error.code === "remote.auth_rejected") throw error;
    const refreshed = await call_with_credential_refresh(
      args.refresh_credentials,
      args.ref.origin,
      () => args.client.read_chapter_task(args.ref, args.chapter, { sync: false }, args.signal),
    );
    if (refreshed.glossary_id === args.glossary_id) throw error;
    await call_with_credential_refresh(args.refresh_credentials, args.ref.origin, () =>
      args.client.write_chapter_translation(
        args.ref,
        args.chapter,
        { glossary_id: refreshed.glossary_id, paragraphs_zh: [...args.paragraphs_zh] },
        args.signal,
      ),
    );
  }
}
