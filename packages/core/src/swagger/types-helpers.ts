/**
 * 局部 $ref 解引用所需的文档最小类型
 *
 * 仅作为 $ref 解析的根，包含 OpenAPI 3.x components 与 Swagger 2.x definitions。
 */

export interface OpenApiDocumentLike {
  components?: Record<string, Record<string, unknown>>;
  definitions?: Record<string, unknown>;
  [key: string]: unknown;
}
