import type { OpenApiDocument, OpenApiParameter, OpenApiRequestBody, OpenApiResponse } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Postman Collection 导入支持
 *
 * Postman 导出格式（Collection v2.1 / v2.0）结构：
 *   {
 *     info: { name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/..." },
 *     item: [ Item... ]   // 嵌套树：folder（含 item）或 request（含 request）
 *   }
 *
 * Item 为 folder 时：{ name, item: [ Item... ] }
 * 为 request 时：{ name, request: { method, url, header[], body }, response: [...] }
 *
 * 仅支持导入 JSON 模式。转换为 OpenApiDocument，复用下游归一化与 $ref 解引用管线。
 */

/** 是否 Postman 源项目 */
export function isPostmanProject(project: { source?: string }): boolean {
  return project.source === "postman";
}

// ──────────────────────────────────────────────
// Postman 类型（按 Collection v2.1 导出结构）
// ──────────────────────────────────────────────

/** Postman query/variable 参数 */
interface PostmanQueryParam {
  key: string;
  value?: string;
  disabled?: boolean;
  description?: string;
}

/** Postman header */
interface PostmanHeader {
  key: string;
  value?: string;
  disabled?: boolean;
  description?: string;
}

/** Postman url：可为字符串或对象 */
interface PostmanUrl {
  raw?: string;
  path?: (string | { toString: () => string })[];
  query?: PostmanQueryParam[];
  variable?: PostmanQueryParam[];
}

/** Postman 请求体 */
interface PostmanBody {
  /** raw | urlencoded | formdata | file | graphql */
  mode?: string;
  /** raw 模式的文本内容 */
  raw?: string;
  /** raw 选项（含 language: json/xml/text 等） */
  options?: { raw?: { language?: string } };
  /** urlencoded 模式的表单参数 */
  urlencoded?: PostmanQueryParam[];
  /** formdata 模式的表单参数 */
  formdata?: (PostmanQueryParam & { type?: string })[];
}

/** Postman request */
interface PostmanRequest {
  method?: string;
  url?: string | PostmanUrl;
  header?: PostmanHeader[];
  body?: PostmanBody;
  description?: string;
}

/** Postman response（示例） */
interface PostmanResponse {
  name?: string;
  code?: number;
  status?: string;
  body?: string;
  header?: PostmanHeader[];
}

/** Postman Item（folder 或 request） */
interface PostmanItem {
  name?: string;
  /** folder 时的子项 */
  item?: PostmanItem[];
  /** request 时的请求定义 */
  request?: PostmanRequest | string;
  response?: PostmanResponse[];
  description?: string;
}

/** Postman 顶层集合 */
export interface PostmanCollection {
  info?: { name?: string; description?: string; schema?: string };
  item?: PostmanItem[];
}

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

/** 判断是否为合法的 Postman Collection 导出（v2.x） */
export function isPostmanCollection(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const o = obj as PostmanCollection;
  // v2.x 集合必有 item 数组；info.schema 形如 .../collection/v2.x.0/...
  if (!Array.isArray(o.item)) return false;
  return true;
}

/** 从 Postman url（字符串或对象）提取路径部分（去掉协议与主机，仅保留 path） */
function extractPath(url: string | PostmanUrl | undefined): string {
  if (!url) return "/";
  // url 为字符串：取 path 部分
  if (typeof url === "string") {
    const raw = url.trim();
    if (!raw) return "/";
    // 形如 {{host}}/api/x 或 http://host/api/x：取第一个 / 之后（含）的内容
    const slashIdx = raw.indexOf("/");
    if (slashIdx < 0) return "/";
    // 排除协议前缀（http://）的 //：从 host 之后开始
    const noProto = raw.replace(/^[a-zA-Z]+:\/\//, "");
    const hostSlash = noProto.indexOf("/");
    const pathPart = hostSlash >= 0 ? noProto.slice(hostSlash) : "/";
    // 去掉 query string
    const qIdx = pathPart.indexOf("?");
    return qIdx >= 0 ? pathPart.slice(0, qIdx) : pathPart;
  }
  // url 为对象：优先用 path 数组拼接
  if (Array.isArray(url.path) && url.path.length > 0) {
    const pathStr = url.path.map((p) => String(p)).join("/");
    return pathStr.startsWith("/") ? pathStr : "/" + pathStr;
  }
  // 回退到 raw
  return extractPath(url.raw);
}

/** 安全解析 JSON 字符串为对象（失败返回 undefined） */
function tryParseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Postman query 参数 → OpenApi parameter */
function convertQueryParams(params: PostmanQueryParam[] | undefined): OpenApiParameter[] | undefined {
  if (!params || params.length === 0) return undefined;
  return params
    .filter((p) => p && p.key)
    .map((p) => ({
      name: p.key,
      in: "query",
      required: false,
      description: p.description || "",
      schema: { type: "string" },
    }));
}

/** Postman header → OpenApi parameter */
function convertHeaders(headers: PostmanHeader[] | undefined): OpenApiParameter[] | undefined {
  if (!headers || headers.length === 0) return undefined;
  return headers
    .filter((h) => h && h.key)
    .map((h) => ({
      name: h.key,
      in: "header",
      required: false,
      description: h.description || "",
      schema: { type: "string" },
    }));
}

/**
 * Postman 请求体 → OpenApi requestBody
 *
 * - raw + language=json：尝试解析为 JSON schema，失败则作为 example
 * - raw（xml/text）：text/plain 或 application/xml
 * - urlencoded：application/x-www-form-urlencoded
 * - formdata：multipart/form-data
 */
function convertBody(body: PostmanBody | undefined): OpenApiRequestBody | undefined {
  if (!body || !body.mode) return undefined;
  const mode = body.mode.toLowerCase();

  if (mode === "raw") {
    const language = body.options?.raw?.language;
    const raw = body.raw || "";
    if (language === "json") {
      const parsed = tryParseJson(raw);
      // 若解析结果形如 JSON Schema（含 type/properties 等），作为 schema；否则作为 example
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const looksSchema = ["type", "properties", "items", "required", "$ref"].some((k) => k in obj);
        if (looksSchema) {
          return { required: true, content: { "application/json": { schema: obj } } };
        }
        // 非 schema 的 JSON：作为 example，附一个 object 占位 schema
        return {
          required: true,
          content: { "application/json": { schema: { type: "object" }, example: parsed } },
        };
      }
      // 非合法 JSON：作为原始文本
      return { description: raw, content: { "application/json": { schema: { type: "string", description: raw } } } };
    }
    if (language === "xml") {
      return { description: raw, content: { "application/xml": { schema: { type: "string" } } } };
    }
    // 默认 raw（text）
    return { description: raw, content: { "text/plain": { schema: { type: "string" } } } };
  }

  if (mode === "urlencoded" || mode === "formdata") {
    const formParams = (mode === "urlencoded" ? body.urlencoded : body.formdata) as (PostmanQueryParam & { type?: string })[];
    if (!formParams || formParams.length === 0) return undefined;
    const properties: Record<string, unknown> = {};
    for (const p of formParams) {
      if (!p.key) continue;
      properties[p.key] = { type: p.type || "string", description: p.description || "" };
    }
    const schema: Record<string, unknown> = { type: "object", properties };
    const ct = mode === "urlencoded" ? "application/x-www-form-urlencoded" : "multipart/form-data";
    return { description: "表单参数", content: { [ct]: { schema } } };
  }

  // file / graphql / 其他：不转换
  return undefined;
}

/** Postman response 数组 → OpenApi responses（body 为示例文本） */
function convertResponses(responses: PostmanResponse[] | undefined): Record<string, OpenApiResponse> | undefined {
  if (!responses || responses.length === 0) return undefined;
  const out: Record<string, OpenApiResponse> = {};
  for (const resp of responses) {
    const code = String(resp.code ?? 200);
    const bodyText = resp.body;
    let content: OpenApiResponse["content"];
    if (bodyText) {
      const parsed = tryParseJson(bodyText);
      content = parsed !== undefined
        ? { "application/json": { example: parsed } }
        : { "text/plain": { schema: { type: "string", description: bodyText } } };
    }
    out[code] = {
      description: resp.name || resp.status || "响应",
      ...(content ? { content } : {}),
    };
  }
  return out;
}

/** 递归遍历 item 树，提取所有含 request 的叶子节点 */
function collectRequestItems(items: PostmanItem[] | undefined): { item: PostmanItem; path: string[] }[] {
  if (!items || !Array.isArray(items)) return [];
  const result: { item: PostmanItem; path: string[] }[] = [];
  for (const item of items) {
    if (!item) continue;
    // request 节点：含 request 字段（接口定义）
    if (item.request !== undefined) {
      result.push({ item, path: [] });
    }
    // 文件夹节点（或 request 也含 item）：递归
    if (Array.isArray(item.item)) {
      result.push(...collectRequestItems(item.item));
    }
  }
  return result;
}

/**
 * 将 Postman Collection JSON 转为 OpenApiDocument
 *
 * @param parsed 已解析的 Postman Collection 对象
 * @param title 文档标题（项目名，回退用）
 */
export function convertPostmanToOpenApi(parsed: PostmanCollection, title: string): OpenApiDocument {
  const items = collectRequestItems(parsed.item);
  const paths: OpenApiDocument["paths"] = {};
  let converted = 0;

  for (const { item } of items) {
    // request 可能是字符串（简写形式 url）或对象
    const req = typeof item.request === "string" ? { url: item.request, method: "GET" } : item.request;
    if (!req) continue;

    const method = (req.method || "GET").toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;

    let path = extractPath(req.url);
    // 规范化路径：补前导斜杠
    if (!path || path === "/") path = "/" + (item.name || "");
    if (!path.startsWith("/")) path = "/" + path;
    if (!paths[path]) paths[path] = {};

    // 参数
    const urlObj = typeof req.url === "object" ? req.url : undefined;
    const queryParams = convertQueryParams(urlObj?.query);
    const headerParams = convertHeaders(req.header);
    const parameters = [queryParams, headerParams].filter((p): p is NonNullable<typeof p> => !!p).flat();

    const requestBody = convertBody(req.body);
    const responses = convertResponses(item.response);

    // 描述：优先 request.description，否则用 item.description；清理 HTML
    const rawDesc = req.description || item.description || "";
    const cleanDesc = typeof rawDesc === "string" ? rawDesc.replace(/<[^>]+>/g, "").trim() : "";

    paths[path][method as "get" | "post" | "put" | "delete" | "patch" | "options" | "head"] = {
      summary: item.name || undefined,
      description: cleanDesc || undefined,
      parameters: parameters.length ? parameters : undefined,
      requestBody,
      responses: responses || { "200": { description: "响应" } },
    };
    converted++;
  }

  logger.debug("Postman → OpenApi 转换完成", { total: items.length, converted });
  return {
    openapi: "3.0.0",
    info: { title: parsed.info?.name || title, version: "1.0" },
    paths,
  };
}
