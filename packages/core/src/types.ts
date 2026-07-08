/**
 * 全局类型定义
 */

/** API 文档来源类型 */
export type ApiSource = "swagger" | "yapi" | "apifox" | "postman";

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
   * - apifox: 通过 Apifox 开放 API（export-openapi 端点）拉取标准 OpenAPI 文档，
   *   或导入 Apifox 原生数据导出格式（importMode）
   * - postman: 导入 Postman Collection v2.1/v2.0 导出格式（仅支持导入 JSON）
   */
  source?: ApiSource;
  /**
   * Swagger/OpenAPI 文档地址（source=swagger 时必填）
   * source=yapi 时可为空，由 baseUrl+projectId 构建
   */
  url?: string;
  /**
   * 实例基地址：
   * - source=yapi 时必填，如 https://yapi.example.com
   * - source=apifox 时可选，缺省为公有云默认值 https://api.apifox.com（私有化部署可覆盖）
   */
  baseUrl?: string;
  /**
   * 项目 ID：
   * - source=yapi 时必填（数字或字符串）
   * - source=apifox 自动拉取时必填（Apifox 项目 ID）
   */
  projectId?: string;
  /**
   * 上游接口访问令牌（可选，已加密存储）：
   * - swagger: 上游文档访问令牌（bearer xxx 或纯 token）
   * - yapi: 项目 token
   * - apifox: 访问令牌（Bearer Token，自动拉取时必填）
   */
  token?: string;
  /**
   * 是否为手动导入 JSON 模式：
   * - true：无上游，不自动拉取/刷新缓存，接口文档由用户在导入弹层粘贴 JSON 提供
   * - false/undefined：自动拉取模式（默认）
   *
   * 导入时仍按 source 决定 JSON 格式校验：swagger→OpenAPI/Swagger 文档，yapi→YApi 原生接口详情数组
   */
  importMode?: boolean;
  /**
   * 导入模式下持久化的文档（已校验+转换为 OpenApiDocument）。
   * 导入 JSON 成功后写入；fetchAndParse 在 importMode 时直接返回此字段。
   * 仅 importMode=true 项目使用。
   */
  importedDoc?: OpenApiDocument;
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
  /**
   * 接口文档缓存 TTL（毫秒），默认 2 小时。
   * 未设置或 <=0 时使用默认值。对内存与 Redis 缓存均生效。
   */
  cache_ttl_ms?: number;
  /**
   * 缓存类型：
   * - memory（默认）：单机内存缓存
   * - redis：跨进程共享的 Redis 缓存
   */
  cache_type?: "memory" | "redis";
  /** Redis 连接配置（cache_type=redis 时必填） */
  cache_redis?: CacheRedisConfig;
  /**
   * 是否持久化 Web 后台访问 Token（admin_session_token）：
   * - false / undefined（默认）：每次启动重新生成，URL 中 token 每次变化
   * - true：将生成的 token 持久化到配置文件，重启后复用，Web 后台地址不变
   */
  persist_admin_token?: boolean;
  /**
   * 持久化的 Web 后台访问 Token。
   * 仅当 persist_admin_token=true 时使用与维护；首次启用时生成并保存，
   * 此后每次启动直接复用。关闭持久化时清空。
   */
  admin_session_token?: string;
}

/** Redis 缓存连接配置 */
export interface CacheRedisConfig {
  /** 连接 URL，如 redis://localhost:6379 或 rediss://... */
  url: string;
  /** key 前缀，默认 api-mcp:cache: */
  keyPrefix?: string;
  /** 是否启用 TLS（rediss:// 自动启用） */
  tls?: boolean;
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
