/**
 * 全局类型定义 - API MCP Manager (V1.3)
 */

/** API 文档来源类型 */
export type ApiSource = "swagger" | "yapi";

/** 单个 API 项目配置 */
export interface McpProject {
  /** 项目唯一 ID，格式 proj_xxxxxx */
  id: string;
  /** 项目名称 */
  name: string;
  /** 项目功能描述（供大模型判断接口归属） */
  desc: string;
  /**
   * 文档来源类型：
   * - swagger: url 字段直接指向 Swagger/OpenAPI 文档（默认）
   * - yapi: 由 baseUrl + projectId 拼接 YApi 的 swagger 导出端点
   */
  source?: ApiSource;
  /**
   * Swagger/OpenAPI 文档地址（source=swagger 时必填）
   * source=yapi 时可为空，由 baseUrl+projectId 构建
   */
  url?: string;
  /** YApi 实例基地址（source=yapi 时必填），如 https://yapi.example.com */
  baseUrl?: string;
  /** YApi 项目 ID（source=yapi 时必填），数字或字符串 */
  projectId?: string;
  /** 上游接口访问令牌（可选，已加密存储）；yapi 即项目 token */
  token?: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 更新时间 ISO */
  updatedAt: string;
}

/** 全局设置 */
export interface McpSettings {
  /** MCP 客户端访问本服务的静态 API Key */
  mcp_client_token: string;
  /** 管理后台端口 */
  admin_port: number;
}

/** mcp-projects.json 完整结构 */
export interface McpProjectsConfig {
  settings: McpSettings;
  projects: McpProject[];
  /** 配置文件 schema 版本 */
  schemaVersion: number;
}

/** Swagger 文档解析后的缓存结构 */
export interface SwaggerCacheEntry {
  /** 原始 OpenAPI 文档（已解析内部结构） */
  doc: OpenApiDocument;
  /** 缓存写入时间戳 ms */
  cachedAt: number;
  /** 缓存过期时间戳 ms */
  expiresAt: number;
}

/** OpenAPI 文档最小可用结构 */
export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info: {
    title: string;
    version?: string;
    description?: string;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
  /** 组件/定义（用于 $ref 解引用） */
  components?: Record<string, Record<string, unknown>>;
  definitions?: Record<string, unknown>;
  securityDefinitions?: Record<string, unknown>;
}

/** 单个接口操作 */
export interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  security?: Record<string, unknown>[];
}

/** 接口参数 */
export interface OpenApiParameter {
  name: string;
  /** 参数位置（OpenAPI 3.x: query/header/path/cookie；Swagger 2.x 另含 body/formData） */
  in: "query" | "header" | "path" | "cookie" | "body" | "formData";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
  type?: string;
  format?: string;
  /** Swagger 2.x: 数组元素的 schema */
  items?: Record<string, unknown>;
  /** Swagger 2.x: 枚举值 */
  enum?: unknown[];
}

/** 请求体 */
export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: Record<string, unknown>; example?: unknown }>;
}

/** 响应 */
export interface OpenApiResponse {
  description?: string;
  content?: Record<string, { schema?: Record<string, unknown>; example?: unknown }>;
}
