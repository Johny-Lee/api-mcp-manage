/**
 * Admin API 客户端
 *
 * 首屏从 URL query 提取 admin_session_token，
 * 写入 sessionStorage 并立即清除 URL 中的 token（防泄露），
 * 后续所有请求统一带 X-Admin-Token header。
 */

const TOKEN_KEY = "admin_token";

/** 初始化：从 URL 提取 token 并存 sessionStorage */
export function initAuth(): boolean {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    // 清除 URL 中的 token
    params.delete("token");
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
    window.history.replaceState({}, "", newUrl);
    return true;
  }
  return !!sessionStorage.getItem(TOKEN_KEY);
}

function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export type ApiSource = "swagger" | "yapi";

export interface ProjectItem {
  id: string;
  name: string;
  desc: string;
  source: ApiSource;
  url?: string;
  baseUrl?: string;
  projectId?: string;
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 新增/更新项目入参（兼容 swagger 与 yapi） */
export interface ProjectInput {
  name: string;
  desc: string;
  source?: ApiSource;
  url?: string;
  baseUrl?: string;
  projectId?: string;
  token?: string;
}

export interface SecurityInfo {
  mcpClientToken: string;
  port: number;
  mcpEndpoint: string;
}

export interface TestResult {
  ok: boolean;
  title?: string;
  pathCount?: number;
  version?: string;
  error?: string;
}

export interface ApiItem {
  method: string;
  path: string;
  summary: string;
  deprecated: boolean;
}

export interface ProjectApis {
  title: string;
  count: number;
  apis: ApiItem[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": getToken(),
      ...options.headers,
    },
  });
  if (res.status === 401) {
    throw new Error("鉴权失败：请检查 Admin Token 是否有效");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  getProjects: () => request<ProjectItem[]>("/admin/api/projects"),

  addProject: (data: ProjectInput) =>
    request<ProjectItem>("/admin/api/projects", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateProject: (id: string, patch: Partial<ProjectInput>) =>
    request<{ ok: boolean }>(`/admin/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/admin/api/projects/${id}`, { method: "DELETE" }),

  testConnection: (id: string) =>
    request<TestResult>(`/admin/api/projects/${id}/test`, { method: "POST" }),

  getProjectApis: (id: string, keyword?: string) =>
    request<ProjectApis>(`/admin/api/projects/${id}/apis${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ""}`),

  getSecurity: () => request<SecurityInfo>("/admin/api/security"),

  resetToken: () =>
    request<{ newToken: string }>("/admin/api/security/reset-token", { method: "POST" }),
};
