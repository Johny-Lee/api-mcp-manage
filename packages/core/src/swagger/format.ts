import type { OpenApiDocument, OpenApiOperation, OpenApiParameter } from "../types.js";

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
    lines.push("#### 请求体");
    lines.push("");
    for (const [contentType, media] of Object.entries(op.requestBody.content)) {
      lines.push(`**Content-Type**: \`${contentType}\`${op.requestBody.required ? " (必填)" : ""}`);
      if (media.schema) {
        lines.push("");
        lines.push("Schema:");
        lines.push("```json");
        lines.push(JSON.stringify(media.schema, null, 2));
        lines.push("```");
      }
      if (media.example !== undefined) {
        lines.push("");
        lines.push("示例:");
        lines.push("```json");
        lines.push(JSON.stringify(media.example, null, 2));
        lines.push("```");
      }
      lines.push("");
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
          if (media.schema) {
            lines.push("```json");
            lines.push(JSON.stringify(media.schema, null, 2));
            lines.push("```");
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
  const type = schema.type;
  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    const inner = items ? describeSchema(items) : "any";
    return `array<${inner}>`;
  }
  if (type === "object" || schema.properties) {
    return "object";
  }
  if (typeof type === "string") {
    return type;
  }
  return "object";
}
