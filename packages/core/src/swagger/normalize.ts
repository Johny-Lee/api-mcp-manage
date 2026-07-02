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
 * @returns 新文档对象，不修改入参
 */
export function normalizeDocument(doc: OpenApiDocument): OpenApiDocument {
  // 仅 Swagger 2.x 需要归一化；OpenAPI 3.x 直接返回深拷贝
  const isSwagger2 = !!doc.swagger && !doc.openapi;
  if (!isSwagger2) {
    return cloneDoc(doc);
  }

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
