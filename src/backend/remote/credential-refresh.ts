import { AppError } from "../../shared/error/app-error";

/**
 * 站点凭据被拒绝时触发一次登录链路的 token 续期，成功则对当前请求重试一次；
 * 续期不可用或仍被拒绝时保持原错误，交给调用方的既有失败路径。
 */
export async function call_with_credential_refresh<T>(
  refresh_credentials: ((origin: string) => Promise<boolean>) | null,
  origin: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "remote.auth_rejected") throw error;
    if (refresh_credentials === null) throw error;
    const refreshed = await refresh_credentials(origin).catch(() => false);
    if (!refreshed) throw error;
    return await operation();
  }
}
