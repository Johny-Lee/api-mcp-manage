import type { McpProject, OpenApiDocument } from "../types.js";
import { fetchJson } from "../utils/http.js";
import { logger } from "../utils/logger.js";

/**
 * YApi 原生文档源支持
 *
 * 通过 YApi 开放 API 拉取接口数据（非 swagger 导出）：
 *   1. GET /api/interface/list?project_id=&token=&page=1&limit=1000
 *      → 接口列表（_id / path / method / title / status，无详情）
 *   2. GET /api/interface/get?id=&token=
 *      → 单接口完整定义（req_query / req_headers / req_params / req_body_form /
 *        req_body_other / res_body 等，res_body 为 json-schema 字符串）
 *
 * 拉取后转换为 OpenApiDocument，复用下游归一化与 $ref 解引用管线。
 */

/** 是否 YApi 源项目 */
export function isYapiProject(project: McpProject): boolean {
  return project.source === "yapi";
}

// ──────────────────────────────────────────────
// YApi 原生类型（按 /api/interface/get 返回结构）
// ──────────────────────────────────────────────

interface YapiParam {
  name: string;
  desc?: string;
  required?: string | number; // "1" | "0"
  type?: string; // form 字段类型: text/file 等
  example?: string;
}

interface YapiInterfaceListItem {
  _id: number;
  project_id: number;
  catid: number;
  title: string;
  path: string;
  method: string;
  status?: string;
  add_time?: number;
  up_time?: number;
}

interface YapiInterfaceDetail extends YapiInterfaceListItem {
  desc?: string;
  markdown?: string;
  req_query?: YapiParam[];
  req_headers?: YapiParam[];
  req_params?: YapiParam[];
  /** form | json | raw */
  req_body_type?: string;
  req_body_form?: YapiParam[];
  /** json 类型时的 schema 字符串 */
  req_body_other?: string;
  /** json | raw */
  res_body_type?: string;
  /** 响应体（json 类型时为 schema 字符串） */
  res_body?: string;
  res_body_is_json_schema?: boolean;
  /** 请求体是否为 json-schema（YApi 实际字段名为 req_body_is_json_schema） */
  req_body_is_json_schema?: boolean;
}

/** YApi list 端点返回的分页结构：{ count, total, list } */
interface YapiListData {
  count: number;
  total: number;
  list: YapiInterfaceListItem[];
}

interface YapiResponse<T> {
  errcode: number;
  errmsg: string;
  data: T;
}

// ──────────────────────────────────────────────
// HTTP 客户端
// ──────────────────────────────────────────────

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const base = baseUrl.replace(/\/+$/, "");
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** 拉取项目全部接口列表（自动分页） */
async function fetchInterfaceList(
  baseUrl: string,
  projectId: string,
  token: string,
): Promise<YapiInterfaceListItem[]> {
  const all: YapiInterfaceListItem[] = [];
  const limit = 1000;
  let page = 1;
  // 单次拉取上限 1000；多数项目一页即可，循环兜底
  for (;;) {
    const url = buildUrl(baseUrl, "/api/interface/list", {
      project_id: projectId,
      token,
      page: String(page),
      limit: String(limit),
    });
    const res = (await fetchJson(url)) as YapiResponse<YapiListData | YapiInterfaceListItem[]>;
    if (res.errcode !== 0) {
      throw new Error(`YApi /api/interface/list 失败: ${res.errmsg} (errcode ${res.errcode})`);
    }
    // 兼容两种返回结构：新版 {count,total,list:[...]} 与旧版 data:[...]
    const batch = Array.isArray(res.data)
      ? res.data
      : Array.isArray((res.data as YapiListData)?.list)
        ? (res.data as YapiListData).list
        : [];
    all.push(...batch);
    if (batch.length < limit) break; // 不足一页 → 结束
    page++;
    if (page > 50) break; // 安全上限
  }
  logger.debug("YApi 接口列表拉取完成", { projectId, count: all.length });
  return all;
}

/** 拉取单接口详情 */
async function fetchInterfaceDetail(
  baseUrl: string,
  id: number,
  token: string,
): Promise<YapiInterfaceDetail> {
  const url = buildUrl(baseUrl, "/api/interface/get", {
    id: String(id),
    token,
  });
  const res = (await fetchJson(url)) as YapiResponse<YapiInterfaceDetail>;
  if (res.errcode !== 0) {
    throw new Error(`YApi /api/interface/get 失败 (id=${id}): ${res.errmsg}`);
  }
  return res.data;
}

/**
 * 从 YApi 项目拉取并组装为 OpenApiDocument
 *
 * @param project source=yapi 的项目配置
 */
export async function fetchYapiDocument(project: McpProject): Promise<OpenApiDocument> {
  const baseUrl = project.baseUrl || "";
  const projectId = String(project.projectId || "");
  const token = project.token || "";
  if (!baseUrl) throw new Error("YApi baseUrl 未配置");
  if (!projectId) throw new Error("YApi projectId 未配置");
  if (!token) throw new Error("YApi token 未配置");

  logger.info("拉取 YApi 接口列表", { projectId: project.id, baseUrl });
  const list = await fetchInterfaceList(baseUrl, projectId, token);

  // 逐个拉取详情（并发受限，避免压垮 YApi）
  const details: YapiInterfaceDetail[] = [];
  const concurrency = 5;
  for (let i = 0; i < list.length; i += concurrency) {
    const chunk = list.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map((item) =>
        fetchInterfaceDetail(baseUrl, item._id, token).catch((err) => {
          logger.warn("YApi 接口详情拉取失败，跳过", { id: item._id, error: String(err) });
          return null;
        }),
      ),
    );
    for (const d of results) if (d) details.push(d);
  }

  logger.info("YApi 接口详情拉取完成", { projectId: project.id, count: details.length });
  return convertYapiToOpenApi(details, project.name);
}

// ──────────────────────────────────────────────
// YApi → OpenApiDocument 转换（纯函数，便于测试）
// ──────────────────────────────────────────────

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

/** 把 "1"/"0"/1/0 统一为 boolean */
function toBool(v: unknown): boolean {
  return v === "1" || v === 1 || v === true;
}

/** 安全解析 YApi 的 json-schema 字符串字段 */
function parseSchema(raw: string | undefined, isSchema: boolean): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  // 非 schema（raw 文本）→ 包成简单 schema
  if (!isSchema) return { type: "string", description: raw.slice(0, 200) };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // 解析失败 → 降级为字符串描述
  }
  return { type: "string", description: "(schema 解析失败)" };
}

/** YApi req_query / req_headers → OpenApi parameters */
function convertParams(
  params: YapiParam[] | undefined,
  location: "query" | "header" | "path",
): import("../types.js").OpenApiParameter[] | undefined {
  if (!params || params.length === 0) return undefined;
  return params.map((p) => ({
    name: p.name,
    in: location,
    required: location === "path" ? true : toBool(p.required),
    description: p.desc || "",
    schema: { type: "string" },
  }));
}

/** YApi req_body_form → requestBody (x-www-form-urlencoded object schema) */
function convertFormBody(params: YapiParam[] | undefined): import("../types.js").OpenApiRequestBody | undefined {
  if (!params || params.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = { type: "string", description: p.desc || "" };
    if (toBool(p.required)) required.push(p.name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length) schema.required = required;
  return {
    description: "表单参数",
    content: { "application/x-www-form-urlencoded": { schema } },
  };
}

/**
 * 将 YApi 接口详情数组转为 OpenApiDocument
 *
 * @param details YApi /api/interface/get 返回的详情列表
 * @param title 文档标题（项目名）
 */
export function convertYapiToOpenApi(
  details: YapiInterfaceDetail[],
  title: string,
): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  let converted = 0;

  for (const d of details) {
    const method = (d.method || "GET").toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;
    const path = d.path || "/";
    if (!paths[path]) paths[path] = {};

    // path 参数：YApi 单独存在 req_params
    const pathParams = convertParams(d.req_params, "path");
    const queryParams = convertParams(d.req_query, "query");
    const headerParams = convertParams(d.req_headers, "header");
    const parameters = [pathParams, queryParams, headerParams]
      .filter((p): p is NonNullable<typeof p> => !!p)
      .flat();

    // requestBody
    let requestBody: import("../types.js").OpenApiRequestBody | undefined;
    const bodyType = (d.req_body_type || "").toLowerCase();
    if (bodyType === "form") {
      requestBody = convertFormBody(d.req_body_form);
    } else if (bodyType === "json") {
      // YApi 字段为 req_body_is_json_schema（非 req_body_other_is_json_schema）
      // 未设置时（undefined）默认按 schema 处理；显式 false 时不解析
      const isSchema = d.req_body_is_json_schema !== false;
      const schema = parseSchema(d.req_body_other, isSchema);
      if (schema) {
        requestBody = {
          required: true,
          content: { "application/json": { schema } },
        };
      }
    } else if (bodyType === "raw" && d.req_body_other) {
      requestBody = {
        description: d.req_body_other.slice(0, 200),
        content: { "text/plain": { schema: { type: "string" } } },
      };
    }

    // responses
    // res_body_is_json_schema 显式为 true 时才解析为 schema；false 或未设置 → 不解析
    // （真实 YApi 中 res_body_type=json 但 res_body_is_json_schema=false 时，res_body 可能是空或非 schema 文本）
    const responses: Record<string, import("../types.js").OpenApiResponse> = {};
    const resSchema =
      d.res_body_is_json_schema === true ? parseSchema(d.res_body, true) : undefined;
    responses["200"] = {
      description: "响应",
      ...(resSchema ? { content: { "application/json": { schema: resSchema } } } : {}),
    };

    // 描述优先用 markdown（更干净）；否则清理 HTML；都无则留空
    const rawDesc = d.markdown || d.desc || "";
    const cleanDesc = rawDesc.replace(/<[^>]+>/g, "").trim();

    paths[path][method as "get" | "post" | "put" | "delete" | "patch" | "options" | "head"] = {
      summary: d.title || "",
      description: cleanDesc || undefined,
      tags: d.catid ? [String(d.catid)] : undefined,
      parameters: parameters.length ? parameters : undefined,
      requestBody,
      responses,
    };
    converted++;
  }

  logger.debug("YApi → OpenApi 转换完成", { total: details.length, converted });
  return {
    openapi: "3.0.0",
    info: { title, version: "1.0" },
    paths,
  };
}
