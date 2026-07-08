import type { OpenApiDocument, OpenApiOperation, OpenApiParameter } from "../types.js";
import type { YapiEnv } from "./yapi.js";

/**
 * Markdown 格式化工具
 * 把 OpenAPI 文档节点转为结构化 Markdown（含表格 + JSON 样例）
 */

/** 生成项目接口概要列表 */
export function formatApiList(projectName: string, projectId: string, doc: OpenApiDocument): string {
  const lines: string[] = [];
  lines.push(`### ${projectName} (ID: ${projectId}) - 接口概要列表`);
  lines.push("");

  const pathEntries = Object.entries(doc.paths);
  if (pathEntries.length === 0) {
    lines.push("_该项目暂无接口_");
    return lines.join("\n");
  }

  for (const [path, methods] of pathEntries) {
    for (const [method, op] of Object.entries(methods)) {
      if (!isHttpMethod(method)) continue;
      const summary = op.summary || op.operationId || "(无描述)";
      const deprecatedTag = op.deprecated ? " ⚠️已废弃" : "";
      lines.push(`- **${method.toUpperCase()}** \`${path}\` - ${summary}${deprecatedTag}`);
    }
  }
  return lines.join("\n");
}

/** 关键词过滤接口列表 */
export function filterApiList(doc: OpenApiDocument, keyword?: string): OpenApiDocument {
  if (!keyword) return doc;
  const kw = keyword.toLowerCase();
  const filteredPaths: typeof doc.paths = {};
  for (const [path, methods] of Object.entries(doc.paths)) {
    const matchedMethods: Record<string, OpenApiOperation> = {};
    let matched = false;
    for (const [method, op] of Object.entries(methods)) {
      if (!isHttpMethod(method)) continue;
      const text = [path, op.summary, op.operationId, op.description].filter(Boolean).join(" ").toLowerCase();
      if (text.includes(kw)) {
        matchedMethods[method] = op;
        matched = true;
      }
    }
    if (matched) {
      // 路径匹配则保留该路径下所有方法，否则仅保留匹配方法
      filteredPaths[path] = Object.keys(matchedMethods).length ? matchedMethods : methods;
    }
  }
  return { ...doc, paths: filteredPaths };
}

/** 生成单个接口详情 Markdown */
export function formatApiDetail(
  projectName: string,
  path: string,
  method: string,
  op: OpenApiOperation,
  envs?: YapiEnv[],
): string {
  const lines: string[] = [];
  const upperMethod = method.toUpperCase();
  lines.push(`### ${projectName} - ${upperMethod} \`${path}\``);
  lines.push("");

  if (op.deprecated) lines.push("> ⚠️ **此接口已废弃**");
  if (op.summary) lines.push(`**描述**: ${op.summary}`);
  if (op.description) lines.push(`\n${op.description}`);
  if (op.tags?.length) lines.push(`**标签**: ${op.tags.join(", ")}`);
  lines.push("");

  // 环境域名（YApi 源项目展示，供确认接口实际访问地址）
  if (envs && envs.length) {
    lines.push("#### 环境域名");
    lines.push("");
    lines.push("| 环境名 | 域名 | 公共 Header |");
    lines.push("|--------|------|-------------|");
    for (const e of envs) {
      const headers = (e.header || [])
        .filter((h) => h.name)
        .map((h) => `${h.name}${h.value ? `: ${h.value}` : ""}`);
      lines.push(`| ${e.name} | \`${e.domain}\` | ${headers.join("、") || "—"} |`);
    }
    lines.push("");
  }

  // Parameters
  if (op.parameters && op.parameters.length) {
    lines.push("#### 请求参数");
    lines.push("");
    lines.push("| 参数名 | 位置 | 类型 | 必填 | 描述 |");
    lines.push("|--------|------|------|------|------|");
    for (const p of op.parameters) {
      lines.push(`| \`${p.name}\` | ${p.in} | ${paramType(p)} | ${p.required ? "✅" : ""} | ${p.description || ""} |`);
    }
    lines.push("");
  }

  // Request body
  if (op.requestBody?.content) {
    // 预渲染各 content-type，跳过空 schema（无 properties 的对象）以避免无意义展示
    const rendered: { contentType: string; table?: string[]; schema?: Record<string, unknown>; example?: unknown }[] = [];
    for (const [contentType, media] of Object.entries(op.requestBody.content)) {
      const schema = media.schema as Record<string, unknown> | undefined;
      const table = schema ? schemaToTable(schema) : undefined;
      // 空 schema（对象但无字段）→ 无内容可展示，跳过
      if (schema && !table && isEmptyObjectSchema(schema)) continue;
      rendered.push({ contentType, table, schema, example: media.example });
    }
    // 仅当有可展示内容时才输出「请求体」区块
    if (rendered.length > 0) {
      lines.push("#### 请求体");
      lines.push("");
      for (const { contentType, table, schema, example } of rendered) {
        lines.push(`**Content-Type**: \`${contentType}\`${op.requestBody.required ? " (必填)" : ""}`);
        if (table) {
          lines.push("");
          lines.push("| 参数名 | 类型 | 必填 | 描述 |");
          lines.push("|--------|------|------|------|");
          lines.push(...table);
        } else if (schema) {
          // 非对象 schema（原始类型等）→ 展示 schema JSON
          lines.push("");
          lines.push("Schema:");
          lines.push("```json");
          lines.push(JSON.stringify(schema, null, 2));
          lines.push("```");
        }
        if (example !== undefined) {
          lines.push("");
          lines.push("示例:");
          lines.push("```json");
          lines.push(JSON.stringify(example, null, 2));
          lines.push("```");
        }
        lines.push("");
      }
    }
  }

  // Responses
  if (op.responses) {
    lines.push("#### 响应");
    lines.push("");
    for (const [code, resp] of Object.entries(op.responses)) {
      lines.push(`**${code}**${resp.description ? ` - ${resp.description}` : ""}`);
      if (resp.content) {
        for (const [contentType, media] of Object.entries(resp.content)) {
          lines.push("");
          lines.push(`\`${contentType}\`:`);
          // schema description 含原始 JSON 文本（含 // 注释等无法严格解析）→ 按 text 展示
          const rawText = extractRawJsonText(media.schema);
          if (rawText !== undefined) {
            lines.push("```text");
            lines.push(rawText);
            lines.push("```");
          } else if (media.schema) {
            // 正常对象 schema → 参数表展示
            const table = schemaToTable(media.schema);
            if (table) {
              lines.push("| 参数名 | 类型 | 必填 | 描述 |");
              lines.push("|--------|------|------|------|");
              lines.push(...table);
            } else {
              lines.push("```json");
              lines.push(JSON.stringify(media.schema, null, 2));
              lines.push("```");
            }
          }
          if (media.example !== undefined) {
            lines.push("示例:");
            lines.push("```json");
            lines.push(JSON.stringify(media.example, null, 2));
            lines.push("```");
          }
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * 判断是否为「空对象 schema」：类型为 object 但没有任何字段定义。
 *
 * 形如 { type: "object", properties: {} } 或 { type: "object" }（无 properties）。
 * 这类 schema 没有实际参数可展示，渲染时应跳过。
 */
function isEmptyObjectSchema(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type !== "object" && !schema.properties) return false;
  const props = schema.properties as Record<string, unknown> | undefined;
  return !props || Object.keys(props).length === 0;
}

/**
 * 把对象 schema 的 properties 渲染为表格行（递归展开嵌套对象/数组）。
 *
 * 仅当 schema 是对象（含 properties）时返回行数组；否则返回 undefined。
 * 嵌套用树形缩进体现层级（参数名只显示本级字段名，非完整路径）：
 *   data        object
 *   ↳ object    object
 *     ↳ token   string
 *     ↳ userid  string
 *
 * @param depth 递归深度（0=顶层，控制缩进与防止无限递归）
 */
function schemaToTable(schema: Record<string, unknown>, depth = 0): string[] | undefined {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || typeof properties !== "object") return undefined;
  // 防止过深嵌套或循环引用导致爆栈
  if (depth > 10) return undefined;

  const requiredList = (schema.required as unknown[] | undefined) ?? [];
  // 顶层字段直接显示名字；嵌套字段用 ↳ + 每层 2 空格缩进
  const indent = depth === 0 ? "" : "  ".repeat(depth - 1) + "↳ ";
  const rows: string[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== "object") continue;
    const required = requiredList.includes(name) ? "✅" : "";
    const desc = (prop.description as string | undefined) || "";
    const nameCell = `${indent}\`${name}\``;

    // 数组：展开元素 schema（若元素为对象，递归其 properties）
    if ((prop.type as string) === "array") {
      const items = prop.items as Record<string, unknown> | undefined;
      const itemType = items ? describeSchema(items) : "any";
      rows.push(`| ${nameCell} | array<${itemType}> | ${required} | ${desc} |`);
      if (items && (items.properties || (items.type as string) === "object")) {
        rows.push(...(schemaToTable(items, depth + 1) || []));
      }
      continue;
    }

    // 对象：先输出自身行，再递归展开内部 properties
    if ((prop.type as string) === "object" || prop.properties) {
      rows.push(`| ${nameCell} | object | ${required} | ${desc} |`);
      const nested = schemaToTable(prop, depth + 1);
      if (nested) rows.push(...nested);
      continue;
    }

    // 原始类型
    rows.push(`| ${nameCell} | ${describeSchema(prop)} | ${required} | ${desc} |`);
  }
  return rows.length ? rows : undefined;
}

/**
 * 检测 schema.description 是否为原始响应 JSON 文本（YApi 中常见：
 * res_body_is_json_schema=true 但 res_body 实为含 // 注释的 JSON 文本，
 * 无法被 JSON.parse 严格解析，被降级存入 description）。
 *
 * 命中时返回该原始文本（按 text 展示）；否则返回 undefined。
 */
function extractRawJsonText(schema: Record<string, unknown> | undefined): string | undefined {
  if (!schema) return undefined;
  // 形如 { type: "string", description: "{ ...json-like... }" }
  if (schema.type !== "string") return undefined;
  const desc = schema.description;
  if (typeof desc !== "string" || desc.length === 0) return undefined;
  // 仅当 description 形似 JSON 文本（含花括号或方括号）时视为原始响应文本
  if (!/[[{]/.test(desc)) return undefined;
  return desc;
}



/** 未找到接口的友好提示 */
export function formatNotFound(projectName: string, path: string, method: string): string {
  return [
    `### 未找到接口`,
    ``,
    `项目 **${projectName}** 中不存在 **${method.toUpperCase()}** \`${path}\`。`,
    ``,
    `请使用 \`get_api_list\` 工具确认该项目的可用接口列表与正确的 HTTP 方法。`,
  ].join("\n");
}

function isHttpMethod(m: string): m is "get" | "post" | "put" | "delete" | "patch" | "options" | "head" {
  return ["get", "post", "put", "delete", "patch", "options", "head"].includes(m.toLowerCase());
}

function paramType(p: OpenApiParameter): string {
  if (p.schema) {
    return describeSchema(p.schema as Record<string, unknown>);
  }
  return p.type || p.format || "string";
}

/** 把 schema 节点描述为人类可读类型串（解引用后可能为对象/数组/原始类型） */
function describeSchema(schema: Record<string, unknown>): string {
  // 解引用失败的残留 $ref：显示短名而非完整路径
  if (typeof schema.$ref === "string") {
    const shortName = schema.$ref.split("/").pop() || schema.$ref;
    return `ref: ${shortName}`;
  }
  // nullable（OpenAPI 3.0 形态；3.1 已被 normalize 降级为此形态）→ 类型末尾加 ?
  const nullableSuffix = schema.nullable === true ? "?" : "";
  const type = schema.type;
  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    const inner = items ? describeSchema(items) : "any";
    return `array<${inner}>`;
  }
  if (type === "object" || schema.properties) {
    return "object" + nullableSuffix;
  }
  if (typeof type === "string") {
    return type + nullableSuffix;
  }
  return "object";
}
