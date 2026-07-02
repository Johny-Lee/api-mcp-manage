import { logger } from "../utils/logger.js";
import type { OpenApiDocumentLike } from "./types-helpers.js";

/**
 * 局部 $ref 解引用
 *
 * 仅对传入的目标节点做递归 $ref 解引用，不展开整个文档 —— 避免内存暴涨。
 *
 * 支持的 $ref 形式：
 * - OpenAPI 3.x: "#/components/schemas/Foo"、"#/components/responses/Bar"
 * - Swagger 2.x: "#/definitions/Foo"
 * - 节点内嵌套的 $ref（递归解析）
 *
 * 防循环引用：用解析栈记录已访问的 $ref 路径，循环时返回占位引用。
 */

const MAX_DEPTH = 20;

/**
 * 解引用单个 schema 节点
 * @param targetNode 目标节点（如单个接口的 response schema）
 * @param fullDoc 完整 OpenAPI 文档（作为 $ref 解析的根）
 * @returns 解引用后的新节点（深拷贝，$ref 已被实际内容替换）
 */
export function dereferenceNode(
  targetNode: Record<string, unknown>,
  fullDoc: OpenApiDocumentLike,
): Record<string, unknown> {
  return resolveRefs(targetNode, fullDoc, [], new Set()) as Record<string, unknown>;
}

/** 递归解析对象/数组中所有 $ref */
function resolveRefs(
  node: unknown,
  doc: OpenApiDocumentLike,
  stack: string[],
  visited: Set<string>,
): unknown {
  if (node === null || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, doc, stack, visited));
  }

  const obj = node as Record<string, unknown>;

  // 若该对象本身就是 $ref，先解析引用
  if (typeof obj.$ref === "string") {
    const resolved = resolveRef(obj.$ref, doc, stack, visited);
    if (resolved !== undefined) {
      // 解析后的内容继续递归（处理嵌套 $ref），并合并同级非 $ref 属性
      const { $ref: _omit, ...rest } = obj;
      const merged = { ...resolved, ...rest };
      return resolveRefs(merged, doc, stack, visited);
    }
    // 解析失败：保留原 $ref（便于调试）
    return obj;
  }

  // 普通对象：递归处理每个属性
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = resolveRefs(value, doc, stack, visited);
  }
  return out;
}

/** 解析单个 $ref 字符串到文档中的目标节点 */
function resolveRef(
  ref: string,
  doc: OpenApiDocumentLike,
  stack: string[],
  visited: Set<string>,
): Record<string, unknown> | undefined {
  if (stack.length >= MAX_DEPTH) {
    logger.warn("解引用深度超限，可能存在循环引用", { ref, depth: stack.length });
    return undefined;
  }
  if (visited.has(ref)) {
    // 循环引用：返回占位，避免无限递归
    return { $circular_ref: ref } as unknown as Record<string, unknown>;
  }

  // 仅支持内部引用（# 开头）
  if (!ref.startsWith("#")) {
    return undefined;
  }

  // 按 JSON Pointer 解析：#/components/schemas/Pet → ["components", "schemas", "Pet"]
  const pointer = ref.slice(1); // 去掉 #
  if (pointer.length === 0) return doc as unknown as Record<string, unknown>;

  const parts = pointer.split("/").filter(Boolean).map((p) => decodeURIComponent(p.replace(/~1/g, "/").replace(/~0/g, "~")));

  let current: unknown = doc;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined) {
    logger.warn("$ref 目标不存在", { ref });
    return undefined;
  }

  // 递归解析被引用节点内部可能的 $ref（携带 visited 栈）
  const newVisited = new Set(visited);
  newVisited.add(ref);
  return resolveRefs(
    current as Record<string, unknown>,
    doc,
    [...stack, ref],
    newVisited,
  ) as Record<string, unknown>;
}
