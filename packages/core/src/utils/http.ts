/**
 * HTTP 拉取工具
 *
 * Node 20+ 内置 fetch 原生支持 HTTP_PROXY / HTTPS_PROXY 环境变量，
 * 无需显式设置 ProxyAgent。
 */

/** 带 timeout 的 fetch */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取 JSON 文档（带鉴权 header 注入） */
export async function fetchJson(
  url: string,
  token?: string,
  timeoutMs?: number,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json, application/octet-stream",
  };
  if (token) {
    // 兼容 "bearer xxx" 直接传入 或 纯 token
    const authValue = token.startsWith("bearer ") || token.startsWith("Bearer ")
      ? token
      : `Bearer ${token}`;
    headers["Authorization"] = authValue;
  }
  const res = await fetchWithTimeout(url, { headers, timeoutMs });
  if (!res.ok) {
    throw new Error(`上游响应 ${res.status} ${res.statusText}: ${url}`);
  }
  return res.json();
}
