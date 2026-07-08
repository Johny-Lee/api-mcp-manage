import type { McpProject, OpenApiDocument, OpenApiParameter, OpenApiRequestBody, OpenApiResponse } from "../types.js";
import type { YapiEnv } from "./yapi.js";
import { fetchWithTimeout } from "../utils/http.js";
import { logger } from "../utils/logger.js";

/**
 * Apifox 支持
 *
 * 两种接入方式：
 *
 * 1. 自动拉取（推荐）：通过 Apifox 开放 API 的 export-openapi 端点直接拉取标准
 *    OpenAPI 文档，无需手动导出。仅需配置 projectId + 访问令牌（baseUrl 默认
 *    https://api.apifox.com，支持私有化部署覆盖）。
 *    POST {baseUrl}/v1/projects/{projectId}/export-openapi
 *      Headers: Authorization: Bearer {token}, X-Apifox-Api-Version: 2024-03-28
 *      Body:    { scope: { type: "ALL" }, oasVersion, exportFormat, options }
 *    → 返回标准 OpenAPI/Swagger 文档，复用 validateOpenApi + normalizeDocument 管线
 *
 * 2. 导入 JSON：用户手动从 Apifox「数据导出 → Apifox」导出原生格式（含 collection）
 *    后粘贴，由 convertApifoxToOpenApi 转换。原生结构：
 *    {
 *      apifoxProject, apifoxVersion,
 *      info: { name, description, ... },
 *      collection: [ CollectionItem... ],  // 嵌套树：folder / api
 *      environments: [...]
 *    }
 *    CollectionItem 为 folder 时 { name, items: [...] }；
 *    为 api 时 { name, method: { method, path }, request: {...}, response: [...] }
 */

/** Apifox 开放 API 基地址默认值（公有云） */
export const APIFOX_DEFAULT_BASE_URL = "https://api.apifox.com";

/** Apifox 开放 API 版本号（X-Apifox-Api-Version 头） */
export const APIFOX_API_VERSION = "2024-03-28";

/** 是否 Apifox 源项目 */
export function isApifoxProject(project: McpProject): boolean {
  return project.source === "apifox";
}

// ──────────────────────────────────────────────
// 导入模式：Apifox 数据导出 JSON（项目设置 → 数据导出 → Apifox 格式）
// ──────────────────────────────────────────────

/**
 * Apifox 导出 JSON 实际结构（按真实导出样本整理）：
 *   {
 *     apifoxProject, info: { name, description },
 *     apiCollection: [ CollectionNode... ],   // 嵌套树：folder / api
 *     environments: [...]
 *   }
 *
 * CollectionNode 为 folder 时：{ name, items: [ CollectionNode... ] }
 * 为 api 时：{ name, api: { method, path, parameters, requestBody, responses, description }, items? }
 *
 * api.parameters: { query, path, header, cookie }（每项含 name/required/type/description）
 * api.requestBody: { type: "none"|"json"|"multipart/form-data"|..., parameters, jsonSchema? }
 * api.responses[]: { code, name, jsonSchema, contentType }  // jsonSchema 已是对象，非字符串
 */

/** Apifox 参数（query/path/header/cookie） */
interface ApifoxParam {
  name: string;
  type?: string;
  /** 是否必填（boolean） */
  required?: boolean;
  description?: string;
  example?: unknown;
}

/** Apifox 请求体 */
interface ApifoxRequestBody {
  /** none | json | multipart/form-data | application/x-www-form-urlencoded | raw */
  type?: string;
  /** 表单参数（multipart / urlencoded 模式） */
  parameters?: ApifoxParam[];
  /** json 模式的 schema（对象，非字符串） */
  jsonSchema?: Record<string, unknown>;
  /** raw 模式文本 */
  raw?: string;
}

/** Apifox 单个响应 */
interface ApifoxResponse {
  code?: number | string;
  name?: string;
  /** 响应体 schema（对象，非字符串） */
  jsonSchema?: Record<string, unknown>;
  /** json | xml | raw | ... */
  contentType?: string;
}

/** Apifox api 节点（接口定义） */
interface ApifoxApiDef {
  method?: string;
  path?: string;
  parameters?: {
    query?: ApifoxParam[];
    path?: ApifoxParam[];
    header?: ApifoxParam[];
    cookie?: ApifoxParam[];
  };
  requestBody?: ApifoxRequestBody;
  responses?: ApifoxResponse[];
  description?: string;
}

/** Apifox collection 节点（folder 或 api） */
interface ApifoxCollectionNode {
  name?: string;
  /** folder 时的子项；api 节点也可能含 items */
  items?: ApifoxCollectionNode[];
  /** api 节点独有：接口定义 */
  api?: ApifoxApiDef;
}

/** Apifox 导出顶层结构 */
export interface ApifoxExport {
  apifoxProject?: string;
  info?: { name?: string; description?: string };
  /** 接口集合（嵌套树） */
  apiCollection?: ApifoxCollectionNode[];
  /** 兼容旧版字段名 collection */
  collection?: ApifoxCollectionNode[];
  environments?: unknown[];
}

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

/** Apifox 请求体 type → OpenAPI Content-Type */
const BODY_TYPE_CONTENT_TYPE: Record<string, string> = {
  json: "application/json",
  "application/json": "application/json",
  "multipart/form-data": "multipart/form-data",
  "application/x-www-form-urlencoded": "application/x-www-form-urlencoded",
  xml: "application/xml",
  raw: "text/plain",
};

/** 把 required 字段统一为 boolean */
function toBool(v: unknown): boolean {
  return v === true || v === "1" || v === 1;
}

/** Apifox 参数（query/path/header）→ OpenApi parameter */
function convertParams(
  params: ApifoxParam[] | undefined,
  location: "query" | "header" | "path",
): OpenApiParameter[] | undefined {
  if (!params || params.length === 0) return undefined;
  return params
    .filter((p) => p && p.name)
    .map((p) => ({
      name: p.name,
      in: location,
      required: location === "path" ? true : toBool(p.required),
      description: p.description || "",
      schema: { type: p.type || "string" },
    }));
}

/** Apifox 请求体 → OpenApi requestBody */
function convertRequestBody(body: ApifoxRequestBody | undefined): OpenApiRequestBody | undefined {
  if (!body || !body.type) return undefined;
  const type = body.type.toLowerCase();
  if (type === "none") return undefined;

  // json：jsonSchema 已是对象
  if (type === "json" || type === "application/json") {
    if (!body.jsonSchema) return undefined;
    return {
      required: true,
      content: { "application/json": { schema: body.jsonSchema } },
    };
  }
  // 表单（multipart / urlencoded）
  if (type === "multipart/form-data" || type === "application/x-www-form-urlencoded" || type === "form") {
    const formParams = body.parameters || [];
    if (formParams.length === 0) return undefined;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of formParams) {
      if (!p.name) continue;
      properties[p.name] = { type: p.type || "string", description: p.description || "" };
      if (toBool(p.required)) required.push(p.name);
    }
    const schema: Record<string, unknown> = { type: "object", properties };
    if (required.length) schema.required = required;
    const ct = BODY_TYPE_CONTENT_TYPE[type] || "multipart/form-data";
    return { description: "表单参数", content: { [ct]: { schema } } };
  }
  // raw / xml
  if (type === "raw" || type === "xml") {
    const text = body.raw || "";
    const ct = type === "xml" ? "application/xml" : "text/plain";
    return {
      description: text,
      content: { [ct]: { schema: { type: "string" } } },
    };
  }
  return undefined;
}

/** Apifox 响应数组 → OpenApi responses */
function convertResponses(responses: ApifoxResponse[] | undefined): Record<string, OpenApiResponse> | undefined {
  if (!responses || responses.length === 0) return undefined;
  const out: Record<string, OpenApiResponse> = {};
  for (const resp of responses) {
    const code = String(resp.code ?? 200);
    // jsonSchema 已是对象；contentType=json → application/json
    const ct = resp.contentType === "json" ? "application/json" : (resp.contentType || "application/json");
    out[code] = {
      description: resp.name || "响应",
      ...(resp.jsonSchema ? { content: { [ct]: { schema: resp.jsonSchema } } } : {}),
    };
  }
  return out;
}

/** 递归遍历 apiCollection，提取所有 api 节点 */
function collectApiNodes(items: ApifoxCollectionNode[] | undefined): ApifoxCollectionNode[] {
  if (!items || !Array.isArray(items)) return [];
  const apis: ApifoxCollectionNode[] = [];
  for (const item of items) {
    if (!item) continue;
    // api 节点：含 api 字段（接口定义）
    if (item.api && typeof item.api === "object" && item.api.path !== undefined) {
      apis.push(item);
    }
    // 文件夹节点（或 api 节点也含 items）：递归
    if (Array.isArray(item.items)) {
      apis.push(...collectApiNodes(item.items));
    }
  }
  return apis;
}

/**
 * 将 Apifox 导出 JSON 转为 OpenApiDocument
 *
 * @param parsed 已解析的 Apifox 导出对象
 * @param title 文档标题（项目名，回退用）
 */
export function convertApifoxToOpenApi(parsed: ApifoxExport, title: string): OpenApiDocument {
  // 兼容 apiCollection（新）与 collection（旧）
  const collection = Array.isArray(parsed.apiCollection) ? parsed.apiCollection : parsed.collection;
  const nodes = collectApiNodes(Array.isArray(collection) ? collection : []);

  const paths: OpenApiDocument["paths"] = {};
  let converted = 0;

  for (const node of nodes) {
    const api = node.api!;
    const method = (api.method || "get").toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;
    let path = api.path || "/";
    // 规范化路径：补前导斜杠
    if (!path.startsWith("/")) path = "/" + path;
    if (!paths[path]) paths[path] = {};

    // 参数
    const pathParams = convertParams(api.parameters?.path, "path");
    const queryParams = convertParams(api.parameters?.query, "query");
    const headerParams = convertParams(api.parameters?.header, "header");
    const parameters = [pathParams, queryParams, headerParams]
      .filter((p): p is NonNullable<typeof p> => !!p)
      .flat();

    const requestBody = convertRequestBody(api.requestBody);
    const responses = convertResponses(api.responses);

    // 描述清理 HTML
    const rawDesc = api.description || "";
    const cleanDesc = rawDesc.replace(/<[^>]+>/g, "").trim();

    paths[path][method as "get" | "post" | "put" | "delete" | "patch" | "options" | "head"] = {
      summary: node.name || undefined,
      description: cleanDesc || undefined,
      parameters: parameters.length ? parameters : undefined,
      requestBody,
      responses: responses || { "200": { description: "响应" } },
    };
    converted++;
  }

  logger.debug("Apifox → OpenApi 转换完成", { total: nodes.length, converted });
  // title 优先级：info.name（真实项目名）> apifoxProject > 传入 title
  // 真实导出中 info.name 为项目名，apifoxProject 可能是版本号字符串
  return {
    openapi: "3.0.0",
    info: { title: parsed.info?.name || parsed.apifoxProject || title, version: "1.0" },
    paths,
  };
}

// ──────────────────────────────────────────────
// 自动拉取（Apifox 开放 API export-openapi 端点）
// ──────────────────────────────────────────────

/** export-openapi 请求体（scope + 导出选项） */
export interface ApifoxExportBody {
  scope: { type: "ALL" };
  oasVersion: "3.0" | "3.1" | "2.0";
  exportFormat: "JSON" | "YAML";
  options: {
    includeApifoxExtensionProperties: boolean;
    addFoldersToTags: boolean;
  };
}

/** export-openapi 请求构造结果（url + body，纯数据，便于单测） */
export interface ApifoxExportRequest {
  url: string;
  body: ApifoxExportBody;
}

/**
 * 构造 export-openapi 请求的 url 与 body（纯函数，不发起网络请求）
 *
 * - baseUrl 缺省时使用公有云默认值 https://api.apifox.com
 * - 固定导出 OpenAPI 3.0 + JSON，含全部接口（scope.type=ALL），不含 Apifox 扩展字段
 *
 * @param project source=apifox 的项目配置
 * @returns { url, body } 请求地址与 JSON body
 */
export function buildApifoxExportRequest(project: McpProject): ApifoxExportRequest {
  const baseUrl = (project.baseUrl || APIFOX_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const projectId = String(project.projectId || "");
  const url = `${baseUrl}/v1/projects/${projectId}/export-openapi`;
  const body: ApifoxExportBody = {
    scope: { type: "ALL" },
    oasVersion: "3.0",
    exportFormat: "JSON",
    options: {
      includeApifoxExtensionProperties: false,
      addFoldersToTags: false,
    },
  };
  return { url, body };
}

/**
 * 通过 Apifox 开放 API 拉取标准 OpenAPI 文档（自动拉取模式）
 *
 * 调用 export-openapi 端点，返回原始 JSON（标准 OpenAPI/Swagger 文档）。
 * 结构校验与归一化交由调用方（cache.ts 的 fetchAndParse）复用 swagger 源同一管线。
 *
 * @param project source=apifox 的项目配置（需 projectId + token）
 * @returns 上游返回的原始 JSON（预期为 OpenAPI/Swagger 文档）
 */
export async function fetchApifoxDocument(project: McpProject): Promise<unknown> {
  const projectId = String(project.projectId || "");
  const token = project.token || "";
  if (!projectId) throw new Error("Apifox projectId 未配置");
  if (!token) throw new Error("Apifox 访问令牌（token）未配置");

  const { url, body } = buildApifoxExportRequest(project);
  logger.info("拉取 Apifox OpenAPI 文档", { projectId: project.id, url });

  // token 兼容 "bearer xxx" 直接传入或纯 token
  const authValue = token.startsWith("bearer ") || token.startsWith("Bearer ")
    ? token
    : `Bearer ${token}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: authValue,
      "X-Apifox-Api-Version": APIFOX_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // 尝试从响应体提取可读错误信息（Apifox 错误响应为 { code, message, ... }）
    let detail = `${res.status} ${res.statusText}`;
    try {
      const errBody = (await res.json()) as { message?: string; code?: number };
      if (errBody?.message) detail = `${res.status}: ${errBody.message}`;
    } catch {
      // 非 JSON 错误体，忽略
    }
    throw new Error(`Apifox export-openapi 失败: ${detail} (projectId=${projectId})`);
  }

  return res.json();
}

/**
 * 从 OpenAPI 文档的 servers 提取环境域名（供接口详情展示）
 *
 * Apifox 导出的 OpenAPI 文档会把「环境」放在标准 servers 字段。此函数将其转为
 * YapiEnv[] 形态，复用 formatApiDetail 既有「环境域名」表格渲染（与 YApi 对齐）。
 * 导入模式（无 servers）返回 undefined。
 *
 * @param doc 已拉取/归一化的 OpenAPI 文档
 * @returns 环境域名列表，或 undefined（无 servers）
 */
export function extractApifoxEnvs(doc: OpenApiDocument): YapiEnv[] | undefined {
  const servers = (doc as unknown as { servers?: unknown }).servers;
  if (!Array.isArray(servers) || servers.length === 0) return undefined;
  const envs: YapiEnv[] = [];
  for (const s of servers) {
    if (!s || typeof s !== "object") continue;
    const server = s as { url?: unknown; description?: unknown };
    if (typeof server.url !== "string" || !server.url) continue;
    envs.push({
      name: typeof server.description === "string" && server.description ? server.description : server.url,
      domain: server.url,
    });
  }
  return envs.length ? envs : undefined;
}
