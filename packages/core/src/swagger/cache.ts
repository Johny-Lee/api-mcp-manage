import type { McpProject, McpSettings, OpenApiDocument } from "../types.js";
import { fetchJson } from "../utils/http.js";
import { normalizeDocument } from "./normalize.js";
import { fetchYapiDocument, isYapiProject } from "./yapi.js";
import { fetchApifoxDocument, isApifoxProject } from "./apifox.js";
import { isPostmanProject } from "./postman.js";
import { logger } from "../utils/logger.js";
import {
  createCacheStore,
  MemoryCacheStore,
  reinitCacheStore,
  testRedisConnection,
  type CacheStore,
  type CacheStoreInitOptions,
} from "./cache-store.js";

/**
 * Swagger 懒加载缓存
 *
 * 策略：
 * - 首次调用某项目时拉取并解析 Swagger，结果存入缓存（内存或 Redis）
 * - TTL 默认 2 小时，过期后下次调用触发重新拉取
 * - 内存模式：定时 GC 清理已过期条目；Redis 模式：依赖 Redis 自身 TTL
 * - 并发去重：进行中 Promise 在进程内共享，避免重复拉取
 *
 * 通过环境变量 MCP_REDIS_URL 切换为 Redis 跨进程共享缓存。
 */

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

/** 全局缓存存储实例（内存或 Redis） */
let store: CacheStore = createCacheStore();

/** 可被覆盖的 TTL（由 setCacheTtl 设置，默认 2h） */
let ttlMs = DEFAULT_TTL_MS;

/** 拉取中的进行中 Promise（防止并发重复拉取，进程内去重） */
const pending = new Map<string, Promise<OpenApiDocument>>();

/** 启动缓存（内存模式下启动 GC 定时器） */
export function startCacheGc(): void {
  if (store instanceof MemoryCacheStore) {
    store.startGc();
  }
  // Redis 模式依赖 Redis 自身 TTL，无需本地 GC
}

/** 停止缓存（清理定时器 / 关闭连接） */
export async function stopCacheGc(): Promise<void> {
  if (store.close) {
    await store.close();
  }
}

/** 设置缓存 TTL（ms），覆盖默认 2 小时 */
export function setCacheTtl(ms: number): void {
  if (ms > 0) ttlMs = ms;
}

/** 获取当前生效的缓存存储类型 */
export function getCacheKind(): "memory" | "redis" {
  return store.kind;
}

/** 清空缓存 */
export async function clearCache(): Promise<void> {
  pending.clear();
  if (store.clear) {
    await store.clear();
  }
}

/** 重置缓存存储实例为指定实现（测试用） */
export async function setCacheStoreForTest(newStore: CacheStore): Promise<void> {
  await clearCache();
  store = newStore;
}

/**
 * 根据配置重建缓存存储（切换 memory/redis 或修改 Redis 配置时调用）
 *
 * 会关闭旧 store、清空 pending、按新配置创建新 store，并更新 TTL。
 * 调用后需重新 startCacheGc（内存模式）。
 */
export async function reinitCache(settings: McpSettings): Promise<void> {
  const init: CacheStoreInitOptions = {
    cacheType: settings.cache_type,
    redis: settings.cache_redis,
  };
  pending.clear();
  store = await reinitCacheStore(init);
  if (settings.cache_ttl_ms && settings.cache_ttl_ms > 0) {
    ttlMs = settings.cache_ttl_ms;
  } else {
    ttlMs = DEFAULT_TTL_MS;
  }
  logger.info("缓存已按配置重建", { kind: store.kind, ttlMs });
}

/**
 * 测试 Redis 连接是否可用（不修改全局缓存状态）
 *
 * @returns { ok, error? }
 */
export async function testRedis(settings: McpSettings): Promise<{ ok: boolean; error?: string }> {
  const redis = settings.cache_redis;
  if (!redis?.url) {
    return { ok: false, error: "未配置 Redis 连接地址" };
  }
  return testRedisConnection({
    url: redis.url,
    keyPrefix: redis.keyPrefix || "api-mcp:cache:",
    tls: redis.tls || redis.url.startsWith("rediss://"),
  });
}

/** 从缓存获取（过期返回 undefined） */
export async function getCached(projectId: string): Promise<OpenApiDocument | undefined> {
  return store.get(projectId);
}

/** 基本校验 OpenAPI/Swagger 文档结构 */
export function validateOpenApi(doc: unknown): OpenApiDocument {
  if (!doc || typeof doc !== "object") {
    throw new Error("上游返回非 JSON 对象");
  }
  const obj = doc as Record<string, unknown>;
  if (obj.openapi || obj.swagger) {
    // OpenAPI 3.x 或 Swagger 2.x
    if (!obj.paths || typeof obj.paths !== "object") {
      throw new Error("文档缺少 paths 字段");
    }
    return doc as OpenApiDocument;
  }
  throw new Error("无法识别的文档格式（非 OpenAPI/Swagger）");
}

/** 拉取并解析文档（Swagger 源归一化；YApi 源走原生接口拉取后转换） */
async function fetchAndParse(project: McpProject): Promise<OpenApiDocument> {
  // 导入 JSON 模式：不访问上游，直接返回持久化的 importedDoc
  if (project.importMode) {
    if (!project.importedDoc) {
      throw new Error(`项目 ${project.id} 尚未导入数据，请先在接口列表点击「导入 JSON」`);
    }
    return project.importedDoc;
  }

  // postman 源仅支持导入模式（已在上文提前返回）；兜底拦截
  if (isPostmanProject(project)) {
    throw new Error(`项目 ${project.id} 为 Postman 源，仅支持导入 JSON，不支持自动拉取`);
  }

  // 按 source 决定拉取方式（apifox 自动拉取返回标准 OpenAPI，复用 swagger 同一管线）
  const source = isApifoxProject(project) ? "apifox" : isYapiProject(project) ? "yapi" : "swagger";
  logger.info("拉取文档", { projectId: project.id, source });

  let doc: OpenApiDocument;
  if (source === "yapi") {
    // YApi 源：通过原生开放 API 拉取接口列表 + 详情，转换为 OpenApiDocument
    doc = await fetchYapiDocument(project);
  } else if (source === "apifox") {
    // Apifox 源：通过开放 API 的 export-openapi 端点拉取标准 OpenAPI 文档
    const raw = await fetchApifoxDocument(project);
    const validated = validateOpenApi(raw);
    doc = normalizeDocument(validated);
  } else {
    // Swagger 源：直接拉取文档
    if (!project.url) throw new Error(`项目 ${project.id} 未配置 url`);
    const raw = await fetchJson(project.url, project.token);
    const validated = validateOpenApi(raw);
    // 归一化：Swagger 2.x 的 body 参数 / response.schema 统一转为 OpenAPI 3.x 形态
    doc = normalizeDocument(validated);
  }

  logger.info("文档解析成功", {
    projectId: project.id,
    source,
    pathCount: Object.keys(doc.paths).length,
    title: doc.info?.title,
  });
  return doc;
}

/** 懒加载获取项目文档（带并发去重） */
export async function getProjectDoc(project: McpProject): Promise<OpenApiDocument> {
  // 1. 查缓存
  const cached = await store.get(project.id);
  if (cached) return cached;

  // 2. 查进行中
  const inflight = pending.get(project.id);
  if (inflight) return inflight;

  // 3. 发起拉取
  const p = (async () => {
    try {
      const doc = await fetchAndParse(project);
      await store.set(project.id, doc, ttlMs);
      return doc;
    } finally {
      pending.delete(project.id);
    }
  })();
  pending.set(project.id, p);
  return p;
}

/** 主动使某项目缓存失效 */
export async function invalidateProject(projectId: string): Promise<void> {
  await store.delete(projectId);
  logger.debug("缓存已失效", { projectId });
}
