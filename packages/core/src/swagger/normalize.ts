import type { OpenApiDocument, OpenApiOperation, OpenApiParameter, OpenApiRequestBody, OpenApiResponse } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Swagger 2.0 → OpenAPI 3.x 结构归一化
 *
 * 在解析阶段把 Swagger 2.x 的差异化结构转换为 OpenAPI 3.x 一致形态，
 * 使下游的格式化与局部 $ref 解引用只需面对一套数据结构：
 *
 * 归一化项：
 * 1. body 参数 (in:body, schema) → requestBody.content["application/json"].schema
 * 2. formData 参数 (in:formData) → 合并到 requestBody.content["application/x-www-form-urlencoded"].schema
 * 3. 响应 schema (responses[code].schema) → responses[code].content["application/json"].schema
 * 4. consumes/produces → 注入对应 content-type
 *
 * 已是 OpenAPI 3.x 的文档原样返回（深拷贝避免污染上游缓存）。
 * 幂等：对已归一化的结构二次调用不会重复转换。
 */

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "options", "head"] as const;

/**
 * 归一化整篇文档（深拷贝后转换）。
 *
 * 三种分支：
 * - Swagger 2.x → OpenAPI 3.x 结构转换（body/formData/response.schema 等）
 * - OpenAPI 3.1 → 3.0 降级（type 数组、exclusiveMinimum 数字等 → 3.0 形态）
 * - OpenAPI 3.0 → 原样深拷贝
 *
 * @returns 新文档对象，不修改入参
 */
export function normalizeDocument(doc: OpenApiDocument): OpenApiDocument {
  // Swagger 2.x → OpenAPI 3.x 结构转换
  if (isSwagger2(doc)) {
    const out = cloneDoc(doc);
    const consumes = (out as unknown as { consumes?: string[] }).consumes || ["application/json"];
    const produces = (out as unknown as { produces?: string[] }).produces || ["application/json"];

    for (const methods of Object.values(out.paths)) {
      for (const method of HTTP_METHODS) {
        const op = methods[method] as OpenApiOperation | undefined;
        if (!op) continue;
        methods[method] = normalizeOperation(op, consumes, produces);
      }
    }
    logger.debug("Swagger 2.0 文档已归一化为 OpenAPI 3.x 结构", {
      pathCount: Object.keys(out.paths).length,
    });
    return out;
  }

  // OpenAPI 3.1 → 3.0 降级（使下游统一面对 3.0 形态）
  if (isOpenApi31(doc)) {
    const out = downgrade31to30(doc);
    logger.debug("OpenAPI 3.1 文档已降级为 3.0 形态", {
      pathCount: Object.keys(out.paths).length,
    });
    return out;
  }

  // OpenAPI 3.0 → 原样深拷贝
  return cloneDoc(doc);
}

/** 是否 Swagger 2.x */
function isSwagger2(doc: OpenApiDocument): boolean {
  return !!doc.swagger && !doc.openapi;
}

/** 是否 OpenAPI 3.1（openapi 字段以 "3.1" 开头） */
function isOpenApi31(doc: OpenApiDocument): boolean {
  return typeof doc.openapi === "string" && doc.openapi.startsWith("3.1");
}

/** 归一化单个 operation */
function normalizeOperation(
  op: OpenApiOperation,
  consumes: string[],
  produces: string[],
): OpenApiOperation {
  const next: OpenApiOperation = { ...op };

  const bodyParams: OpenApiParameter[] = [];
  const formParams: OpenApiParameter[] = [];
  const otherParams: OpenApiParameter[] = [];

  if (op.parameters) {
    for (const p of op.parameters) {
      if (p.in === "body") bodyParams.push(p);
      else if (p.in === "formData") formParams.push(p);
      else otherParams.push(p);
    }
  }
  next.parameters = otherParams.length ? otherParams : undefined;

  // body 参数 → requestBody
  if (bodyParams.length > 0) {
    next.requestBody = bodyParamToRequestBody(bodyParams[0], consumes);
  }
  // formData 参数 → requestBody (x-www-form-urlencoded)
  // 注意：Swagger 2.x 的 formData 始终以表单编码，不受 consumes 影响
  if (formParams.length > 0) {
    next.requestBody = formParamsToRequestBody(formParams);
  }

  // 响应 schema → content
  if (op.responses) {
    const responses: Record<string, OpenApiResponse> = {};
    for (const [code, resp] of Object.entries(op.responses)) {
      responses[code] = normalizeResponse(resp as OpenApiResponse & { schema?: Record<string, unknown> }, produces);
    }
    next.responses = responses;
  }

  return next;
}

/** Swagger 2.x body 参数 → OpenAPI 3.x requestBody */
function bodyParamToRequestBody(
  param: OpenApiParameter,
  consumes: string[],
): OpenApiRequestBody {
  const ct = consumes[0] || "application/json";
  return {
    description: param.description,
    required: param.required,
    content: {
      [ct]: { schema: param.schema as Record<string, unknown> | undefined },
    },
  };
}

/** Swagger 2.x formData 参数 → OpenAPI 3.x requestBody (object schema) */
function formParamsToRequestBody(
  params: OpenApiParameter[],
): OpenApiRequestBody {
  const ct = "application/x-www-form-urlencoded";

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = paramToInlineSchema(p);
    if (p.required) required.push(p.name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length) schema.required = required;

  return {
    description: "表单参数",
    content: { [ct]: { schema } },
  };
}

/** 单个 formData 参数 → inline schema 片段 */
function paramToInlineSchema(p: OpenApiParameter): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (p.type) s.type = p.type;
  if (p.format) s.format = p.format;
  if (p.description) s.description = p.description;
  // Swagger 2.x 的 items (数组元素 schema)
  if ((p as unknown as { items?: Record<string, unknown> }).items) {
    s.items = (p as unknown as { items?: Record<string, unknown> }).items;
  }
  // 枚举
  const enumVals = (p as unknown as { enum?: unknown[] }).enum;
  if (enumVals) s.enum = enumVals;
  return s;
}

/** Swagger 2.x response (schema 字段) → OpenAPI 3.x response (content) */
function normalizeResponse(
  resp: OpenApiResponse & { schema?: Record<string, unknown> },
  produces: string[],
): OpenApiResponse {
  // 已有 content（OpenAPI 3.x 或已归一化）→ 不动
  if (resp.content) {
    return { description: resp.description, content: resp.content };
  }
  if (!resp.schema) {
    return { description: resp.description };
  }
  const content: Record<string, { schema?: Record<string, unknown> }> = {};
  for (const ct of produces) {
    content[ct] = { schema: resp.schema };
  }
  return { description: resp.description, content };
}

/** 深拷贝文档（缓存共享，必须不可变） */
function cloneDoc(doc: OpenApiDocument): OpenApiDocument {
  return JSON.parse(JSON.stringify(doc)) as OpenApiDocument;
}

// ──────────────────────────────────────────────
// OpenAPI 3.1 → 3.0 降级
// ──────────────────────────────────────────────

/** OpenAPI 3.1 中 schema 组合关键字（值为 schema 数组，需逐项递归） */
const SCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];

/**
 * 把 OpenAPI 3.1 文档降级为 3.0 形态（深拷贝后就地改写）。
 *
 * 主要处理：
 * - schema.type 为数组（如 ["string","null"]）→ 标量 type + nullable
 * - exclusiveMinimum/exclusiveMaximum 为数字 → minimum/maximum + 布尔 exclusive*
 * - 顶层 openapi 版本号 "3.1.x" → "3.0.3"
 *
 * 递归遍历 paths 下所有 schema（parameters.schema / requestBody.content / responses.content）
 * 与 components/schemas，以及 schema 内部嵌套（properties/items/allOf 等）。
 */
function downgrade31to30(doc: OpenApiDocument): OpenApiDocument {
  const out = cloneDoc(doc);

  // 递归遍历 paths 下每个 operation 的 schema 节点
  for (const methods of Object.values(out.paths)) {
    for (const method of Object.values(methods)) {
      const op = method as OpenApiOperation | undefined;
      if (!op) continue;
      // 参数 schema
      if (op.parameters) {
        for (const p of op.parameters) {
          if (p.schema) walkSchema(p.schema as Record<string, unknown>);
        }
      }
      // requestBody schema
      if (op.requestBody?.content) {
        for (const media of Object.values(op.requestBody.content)) {
          if (media.schema) walkSchema(media.schema as Record<string, unknown>);
        }
      }
      // responses schema
      if (op.responses) {
        for (const resp of Object.values(op.responses)) {
          if (resp.content) {
            for (const media of Object.values(resp.content)) {
              if (media.schema) walkSchema(media.schema as Record<string, unknown>);
            }
          }
        }
      }
    }
  }

  // components/schemas（3.1 复用定义的集中地）
  const components = (out as unknown as { components?: { schemas?: Record<string, unknown> } }).components;
  if (components?.schemas) {
    for (const schema of Object.values(components.schemas)) {
      if (schema && typeof schema === "object") walkSchema(schema as Record<string, unknown>);
    }
  }

  // 顶层版本号
  out.openapi = "3.0.3";
  return out;
}

/**
 * 深度优先遍历一个 schema 节点，就地降级 3.1 特性为 3.0 形态。
 *
 * 会递归进入 schema 的子节点（properties 值、items、allOf/anyOf/oneOf 成员等）。
 */
function walkSchema(schema: Record<string, unknown>): void {
  if (!schema || typeof schema !== "object") return;

  // 先转换当前节点，再递归子节点（避免子节点转换后又被重复处理）
  convertTypeArray(schema);
  convertExclusiveBounds(schema);

  // 递归 schema 承载的子节点
  // properties / additionalProperties：值是「字段名 → schema」的 map
  for (const key of ["properties", "additionalProperties"]) {
    const child = schema[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      for (const v of Object.values(child as Record<string, unknown>)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          walkSchema(v as Record<string, unknown>);
        }
      }
    }
  }
  // items / not：值是单个 schema 对象
  for (const key of ["items", "not"]) {
    const child = schema[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      walkSchema(child as Record<string, unknown>);
    }
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const list = schema[key];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          walkSchema(item as Record<string, unknown>);
        }
      }
    }
  }
}

/**
 * 把 3.1 的数组类型 type 降级为 3.0 标量 type + nullable。
 *
 * - ["string","null"] → type:"string", nullable:true
 * - ["string","integer"]（纯联合）→ 取首个非 null 类型，其余记入 description
 */
function convertTypeArray(schema: Record<string, unknown>): void {
  const type = schema.type;
  if (!Array.isArray(type)) return;
  const types = type.filter((t) => typeof t === "string");
  if (types.length === 0) {
    delete schema.type;
    return;
  }
  const hasNull = types.includes("null");
  const nonNull = types.filter((t) => t !== "null");
  if (nonNull.length === 0) {
    // 仅 ["null"] → 3.0 无对应表达，删除 type
    delete schema.type;
    if (hasNull) (schema as { nullable?: boolean }).nullable = true;
    return;
  }
  // 取首个非 null 类型作为主类型
  schema.type = nonNull[0];
  if (hasNull) (schema as { nullable?: boolean }).nullable = true;
  // 联合多个类型时，把完整类型列表补到 description 末尾（保留信息）
  if (nonNull.length > 1) {
    const existing = typeof schema.description === "string" ? schema.description : "";
    const note = `(类型可为: ${nonNull.join(" | ")})`;
    schema.description = existing ? `${existing} ${note}` : note;
  }
}

/**
 * 把 3.1 的数字形态 exclusiveMinimum/exclusiveMaximum 降级为 3.0 布尔形态。
 *
 * 3.1: exclusiveMinimum: 0      → 3.0: minimum: 0, exclusiveMinimum: true
 * 3.1: exclusiveMaximum: 10     → 3.0: maximum: 10, exclusiveMaximum: true
 * 3.0 原有的布尔形态不受影响。
 */
function convertExclusiveBounds(schema: Record<string, unknown>): void {
  const min = schema.exclusiveMinimum;
  if (typeof min === "number") {
    schema.minimum = min;
    schema.exclusiveMinimum = true;
  }
  const max = schema.exclusiveMaximum;
  if (typeof max === "number") {
    schema.maximum = max;
    schema.exclusiveMaximum = true;
  }
}
