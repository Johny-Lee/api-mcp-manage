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
  /** 菜单（分类）名，来自 /api/interface/list_menu */
  catname?: string;
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

/** YApi list_menu 端点返回的菜单分组结构 */
interface YapiMenuGroup {
  _id: number;
  name: string;
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

/**
 * 拉取项目全部接口列表（菜单分组接口，含分类名）
 *
 * 调用 /api/interface/list_menu，返回按菜单（分类）分组的接口列表。
 * list_menu 一次返回全部接口（不分页），且每个接口附带所属菜单名（catname），
 * 用于 summary 拼接「接口名「菜单名」」。
 *
 * @returns 展平后的接口列表，每项含 catname（菜单名）
 */
async function fetchInterfaceListMenu(
  baseUrl: string,
  projectId: string,
  token: string,
): Promise<YapiInterfaceListItem[]> {
  const url = buildUrl(baseUrl, "/api/interface/list_menu", {
    project_id: projectId,
    token,
  });
  const res = (await fetchJson(url)) as YapiResponse<YapiMenuGroup[]>;
  if (res.errcode !== 0) {
    throw new Error(`YApi /api/interface/list_menu 失败: ${res.errmsg} (errcode ${res.errcode})`);
  }
  const groups = Array.isArray(res.data) ? res.data : [];
  const all: YapiInterfaceListItem[] = [];
  for (const group of groups) {
    const menuName = group.name || "";
    for (const item of group.list || []) {
      // 注入菜单名，供后续 summary 拼接
      all.push({ ...item, catname: menuName });
    }
  }
  logger.debug("YApi 接口菜单列表拉取完成", { projectId, groupCount: groups.length, count: all.length });
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

// ──────────────────────────────────────────────
// YApi 项目详情（/api/project/get）
// ──────────────────────────────────────────────

/** YApi 环境变量配置（含域名与公共 header） */
export interface YapiEnv {
  _id?: string;
  name: string;
  domain: string;
  header?: { name: string; value: string }[];
  global?: { name: string; value: string }[];
}

/** YApi 项目详情（/api/project/get 返回的 data 子集） */
export interface YapiProjectDetail {
  _id: number;
  name: string;
  basepath?: string;
  project_type?: string;
  icon?: string;
  color?: string;
  add_time?: number;
  up_time?: number;
  env?: YapiEnv[];
  tag?: unknown[];
  cat?: unknown[];
}

/** 拉取 YApi 项目详情（含环境配置） */
export async function fetchYapiProjectDetail(
  project: McpProject,
): Promise<YapiProjectDetail> {
  const baseUrl = project.baseUrl || "";
  const token = project.token || "";
  if (!baseUrl) throw new Error("YApi baseUrl 未配置");
  if (!token) throw new Error("YApi token 未配置");

  const url = buildUrl(baseUrl, "/api/project/get", { token });
  const res = (await fetchJson(url)) as YapiResponse<YapiProjectDetail>;
  if (res.errcode !== 0) {
    throw new Error(`YApi /api/project/get 失败: ${res.errmsg} (errcode ${res.errcode})`);
  }
  logger.debug("YApi 项目详情拉取完成", { projectId: project.id, name: res.data.name });
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
  const list = await fetchInterfaceListMenu(baseUrl, projectId, token);

  // 构建 _id → catname 映射（详情接口不返回菜单名，从列表注入）
  const catnameMap = new Map<number, string>();
  for (const item of list) {
    catnameMap.set(item._id, item.catname || "");
  }

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
    for (const d of results) {
      if (d) {
        // 注入菜单名（详情接口不返回 catname）
        d.catname = catnameMap.get(d._id) || "";
        details.push(d);
      }
    }
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
  // 非 schema（raw 文本）→ 包成简单 schema（保留完整文本，不截断）
  if (!isSchema) return { type: "string", description: raw };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // 解析失败 → 降级为字符串描述（保留完整原始文本）
  }
  return { type: "string", description: raw };
}

/** 判断一个解析后的 JSON 对象是否形如 JSON Schema */
function looksLikeSchema(obj: Record<string, unknown>): boolean {
  // JSON Schema 常见顶层标识：$schema / type / properties / items / required / allOf 等
  const schemaKeys = ["$schema", "type", "properties", "items", "required", "allOf", "anyOf", "oneOf", "definitions"];
  return schemaKeys.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

/**
 * 解析 YApi 响应体 res_body 为 OpenAPI response content。
 *
 * YApi 中 res_body_is_json_schema 可能为 true / false / undefined：
 * - true → res_body 为 JSON Schema 字符串，直接解析为 schema
 * - false/undefined → res_body 可能是具体响应示例 JSON 或非 schema 文本。
 *   尝试解析：若解析后形如 JSON Schema（含 type/properties 等），作为 schema；
 *   否则视为具体响应示例（example），并为其生成一个宽松的 object schema 占位，
 *   保证下游格式化时「响应」部分有内容可展示。
 *
 * @returns { content } 或 undefined（res_body 为空时）
 */
function parseResponseBody(raw: string | undefined, isJsonSchema?: boolean): { content: Record<string, { schema?: Record<string, unknown>; example?: unknown }> } | undefined {
  if (!raw) return undefined;

  // 显式声明为 schema → 直接按 schema 解析
  if (isJsonSchema === true) {
    const schema = parseSchema(raw, true);
    return schema ? { content: { "application/json": { schema } } } : undefined;
  }

  // 未声明或声明为非 schema → 尝试作为 JSON 解析后智能判定
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 非 JSON 文本 → 降级为字符串描述的 schema（保留完整原始文本，不截断）
    return { content: { "application/json": { schema: { type: "string", description: raw } } } };
  }

  // 解析结果为对象且形如 JSON Schema → 作为 schema
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && looksLikeSchema(parsed as Record<string, unknown>)) {
    return { content: { "application/json": { schema: parsed as Record<string, unknown> } } };
  }

  // 否则视为具体响应示例：同时给出 example 与一个宽松的 object schema
  const example = parsed;
  const schema: Record<string, unknown> = Array.isArray(parsed)
    ? { type: "array" }
    : { type: "object" };
  return { content: { "application/json": { schema, example } } };
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
        description: d.req_body_other,
        content: { "text/plain": { schema: { type: "string" } } },
      };
    }

    // responses
    // YApi 中 res_body_is_json_schema 可能为 true/false/undefined。未声明时 res_body
    // 也可能是具体响应示例 JSON，不应直接丢弃。统一交给 parseResponseBody 智能判定。
    const responses: Record<string, import("../types.js").OpenApiResponse> = {};
    const resContent = parseResponseBody(d.res_body, d.res_body_is_json_schema);
    responses["200"] = {
      description: "响应",
      ...(resContent ? { content: resContent.content } : {}),
    };

    // 描述优先用 markdown（更干净）；否则清理 HTML；都无则留空
    const rawDesc = d.markdown || d.desc || "";
    const cleanDesc = rawDesc.replace(/<[^>]+>/g, "").trim();

    // summary 拼接：接口名「菜单名」（有菜单名时）
    const title = d.title || "";
    const catname = d.catname || "";
    const summary = catname ? `${title}「${catname}」` : title;

    paths[path][method as "get" | "post" | "put" | "delete" | "patch" | "options" | "head"] = {
      summary,
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
