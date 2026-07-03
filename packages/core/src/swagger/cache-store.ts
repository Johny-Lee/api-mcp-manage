import type { CacheRedisConfig, OpenApiDocument } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * 缓存存储抽象层
 *
 * 隔离内存与 Redis 两种实现，使 cache.ts 上层逻辑与具体存储无关。
 * - 内存模式：单机零依赖，进程重启即丢失
 * - Redis 模式：跨进程/实例共享，依赖 Redis 自身 TTL 过期
 *
 * 启用方式（优先级从高到低）：
 * 1. 配置文件 settings.cache_type（由 reinitCacheStore 传入）
 * 2. 环境变量 MCP_REDIS_URL（无参数 createCacheStore 时回退）
 */

/** 统一缓存存储接口 */
export interface CacheStore {
  /** 读取缓存（未命中或过期返回 undefined） */
  get(projectId: string): Promise<OpenApiDocument | undefined>;
  /** 写入缓存，ttlMs 为过期时长（ms） */
  set(projectId: string, doc: OpenApiDocument, ttlMs: number): Promise<void>;
  /** 删除单条缓存 */
  delete(projectId: string): Promise<void>;
  /** 清空全部缓存（测试 / 关闭用） */
  clear?(): Promise<void>;
  /** 关闭底层资源（连接 / 定时器） */
  close?(): Promise<void>;
  /** 返回存储类型标识，用于日志与启动横幅 */
  readonly kind: "memory" | "redis";
}

/** 缓存初始化选项（由配置文件传入，覆盖环境变量） */
export interface CacheStoreInitOptions {
  /** 缓存类型，未指定时回退环境变量 */
  cacheType?: "memory" | "redis";
  /** Redis 配置（cacheType=redis 时使用） */
  redis?: CacheRedisConfig;
}

// ──────────────────────────────────────────────
// 内存实现
// ──────────────────────────────────────────────

interface MemoryEntry {
  doc: OpenApiDocument;
  expiresAt: number;
}

const GC_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟扫描一次

/** 内存缓存：Map + TTL + 定时 GC */
export class MemoryCacheStore implements CacheStore {
  readonly kind = "memory" as const;
  private readonly cache = new Map<string, MemoryEntry>();
  private gcTimer: NodeJS.Timeout | null = null;

  async get(projectId: string): Promise<OpenApiDocument | undefined> {
    const entry = this.cache.get(projectId);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(projectId);
      return undefined;
    }
    return entry.doc;
  }

  async set(projectId: string, doc: OpenApiDocument, ttlMs: number): Promise<void> {
    const now = Date.now();
    this.cache.set(projectId, { doc, expiresAt: now + ttlMs });
  }

  async delete(projectId: string): Promise<void> {
    this.cache.delete(projectId);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  /** 启动定时 GC（清理过期条目） */
  startGc(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt < now) {
          this.cache.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.debug("缓存 GC 完成", { cleaned, remaining: this.cache.size });
      }
    }, GC_INTERVAL_MS);
    // 不阻止进程退出
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  /** 停止定时 GC */
  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  async close(): Promise<void> {
    this.stopGc();
    this.cache.clear();
  }
}

// ──────────────────────────────────────────────
// Redis 实现
// ──────────────────────────────────────────────

/** Redis 连接选项（从环境变量解析） */
export interface RedisCacheOptions {
  /** redis[s]://... 连接 URL */
  url: string;
  /** key 前缀，默认 api-mcp:cache: */
  keyPrefix?: string;
  /** 是否启用 TLS（rediss:// 或显式指定） */
  tls?: boolean;
}

/** 解析环境变量为 Redis 选项，未配置时返回 null */
export function parseRedisOptionsFromEnv(): RedisCacheOptions | null {
  const url = process.env.MCP_REDIS_URL;
  if (!url) return null;
  const tls = process.env.MCP_REDIS_TLS === "1" || url.startsWith("rediss://");
  const keyPrefix = process.env.MCP_REDIS_KEY_PREFIX || "api-mcp:cache:";
  return { url, keyPrefix, tls };
}

/**
 * 将 redis[s]:// URL 解析为 ioredis 构造参数。
 *
 * 兼容性处理：
 * - 显式提取 host/port/password，避免 ioredis 对带 username 的 URL（Redis 6 ACL）
 *   发送 `AUTH username password`，导致 Redis 5 报 "wrong number of arguments for 'auth'"。
 * - Redis 5 及以下仅支持 `AUTH password`，因此始终只传 password。
 *
 * @returns ioredis 选项对象（host/port/password/db/tls），不含 URL
 */
export function parseRedisUrl(url: string, tls?: boolean): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  try {
    const u = new URL(url);
    if (u.hostname) opts.host = u.hostname;
    if (u.port) opts.port = parseInt(u.port, 10);
    // username 一律丢弃（兼容 Redis 5），仅取 password
    if (u.password) opts.password = decodeURIComponent(u.password);
    // 数据库序号：路径首段 /?db=1
    const dbStr = u.pathname.replace(/^\//, "");
    if (dbStr) {
      const db = parseInt(dbStr, 10);
      if (!isNaN(db)) opts.db = db;
    }
  } catch {
    // URL 解析失败，回退为直接传 URL（交由 ioredis 处理）
    return { url };
  }
  if (tls) opts.tls = {};
  return opts;
}

/**
 * Redis 缓存实现
 *
 * - doc 序列化为 JSON 字符串存储
 * - 过期完全依赖 Redis SETEX 的 TTL，无本地 GC
 * - get 出错时降级返回 undefined（触发上层重新拉取），仅记录告警，不抛出
 */
export class RedisCacheStore implements CacheStore {
  readonly kind = "redis" as const;
  private readonly keyPrefix: string;
  /** 原始连接配置（供 ensureClient 构建 ioredis 参数） */
  private readonly rawOptions: RedisCacheOptions;
  // ioredis 客户端实例（动态加载，避免未启用时引入）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  /** 记录用于日志的连接 URL（脱敏后） */
  private readonly displayUrl: string;

  constructor(
    options: RedisCacheOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clientImpl?: any,
  ) {
    this.rawOptions = options;
    this.keyPrefix = options.keyPrefix || "api-mcp:cache:";
    this.displayUrl = options.url.replace(/\/\/.*@/, "//***@");
    // 支持外部注入客户端（测试用）；否则延迟到 ensureClient 动态 import
    this.client = clientImpl ?? null;
  }

  private key(projectId: string): string {
    return `${this.keyPrefix}${projectId}`;
  }

  /** 懒加载 ioredis 客户端 */
  private async ensureClient(): Promise<NonNullable<typeof this.client>> {
    if (this.client) return this.client;
    const options = this.rawOptions;
    try {
      // 动态加载 ioredis，避免未启用 Redis 时引入额外开销
      const { default: Ioredis } = await import("ioredis");
      // 解析 URL 为 ioredis 选项，兼容 Redis 5（仅 password 认证）
      const connOpts = parseRedisUrl(options.url, options.tls);
      const client = new Ioredis({
        // 连接失败不抛出，便于降级
        maxRetriesPerRequest: 2,
        ...connOpts,
      });
      client.on("error", (err: unknown) => {
        logger.warn("Redis 连接异常", { error: String(err) });
      });
      client.on("connect", () => {
        logger.info("Redis 缓存已连接", { url: this.displayUrl });
      });
      this.client = client;
      return client;
    } catch (err) {
      logger.error("加载 ioredis 失败，Redis 缓存不可用", { error: String(err) });
      throw err;
    }
  }

  async get(projectId: string): Promise<OpenApiDocument | undefined> {
    try {
      const client = await this.ensureClient();
      const raw = await client.get(this.key(projectId));
      if (!raw) return undefined;
      return JSON.parse(raw) as OpenApiDocument;
    } catch (err) {
      logger.warn("Redis 读取失败，降级为未命中", { projectId, error: String(err) });
      return undefined;
    }
  }

  async set(projectId: string, doc: OpenApiDocument, ttlMs: number): Promise<void> {
    try {
      const client = await this.ensureClient();
      const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
      await client.set(this.key(projectId), JSON.stringify(doc), "EX", ttlSec);
    } catch (err) {
      // 写入失败不阻断业务，下次读取未命中会重新拉取
      logger.warn("Redis 写入失败，缓存未持久化", { projectId, error: String(err) });
    }
  }

  async delete(projectId: string): Promise<void> {
    try {
      const client = await this.ensureClient();
      await client.del(this.key(projectId));
    } catch (err) {
      logger.warn("Redis 删除失败", { projectId, error: String(err) });
    }
  }

  async clear(): Promise<void> {
    try {
      const client = await this.ensureClient();
      // 仅清除当前前缀下的 key（SCAN + DEL，避免阻塞 KEYS）
      let cursor = "0";
      do {
        const [next, keys] = await client.scan(
          cursor, "MATCH", `${this.keyPrefix}*`, "COUNT", 100,
        );
        cursor = next;
        if (keys && keys.length) await client.del(...keys);
      } while (cursor !== "0");
    } catch (err) {
      logger.warn("Redis clear 失败", { error: String(err) });
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // 忽略关闭错误
      }
      this.client = null;
    }
  }
}

// ──────────────────────────────────────────────
// Redis 连接测试（不污染全局单例）
// ──────────────────────────────────────────────

/**
 * 测试 Redis 连接是否可用（PING）。
 *
 * 创建临时 ioredis 实例，PING 成功后立即 quit，不影响全局缓存单例。
 * 用于管理后台「测试连接」功能。
 */
export async function testRedisConnection(
  options: RedisCacheOptions,
): Promise<{ ok: boolean; error?: string }> {
  let client: { ping: () => Promise<string>; quit: () => Promise<unknown>; disconnect?: () => void } | null = null;
  try {
    const { default: Ioredis } = await import("ioredis");
    // 解析 URL 为 ioredis 选项，兼容 Redis 5（仅 password 认证）
    const connOpts = parseRedisUrl(options.url, options.tls);
    client = new Ioredis({
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      // 启用离线队列：命令在连接建立前排队，连接就绪后自动发送
      enableOfflineQueue: true,
      ...connOpts,
    }) as unknown as { ping: () => Promise<string>; quit: () => Promise<unknown>; disconnect?: () => void };
    const reply = await client.ping();
    return reply === "PONG" ? { ok: true } : { ok: false, error: `意外的响应: ${reply}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) {
      try { await client.quit(); } catch { /* ignore */ }
      // quit 后强制断开，避免残留连接
      client.disconnect?.();
    }
  }
}

// ──────────────────────────────────────────────
// 工厂函数 + 单例管理
// ──────────────────────────────────────────────

let currentStore: CacheStore | null = null;
/** 记录当前 store 创建时所用的配置（用于摘要展示） */
let currentInitOptions: CacheStoreInitOptions | null = null;

/** 把 CacheRedisConfig / 环境变量统一为 RedisCacheOptions */
function resolveRedisOptions(init?: CacheStoreInitOptions): RedisCacheOptions | null {
  // 优先用显式传入的配置
  if (init?.redis?.url) {
    return {
      url: init.redis.url,
      keyPrefix: init.redis.keyPrefix || "api-mcp:cache:",
      tls: init.redis.tls || init.redis.url.startsWith("rediss://"),
    };
  }
  // 回退环境变量
  return parseRedisOptionsFromEnv();
}

/**
 * 创建/获取全局缓存存储实例
 *
 * 优先级：显式 initOptions > 环境变量 MCP_REDIS_URL > 内存模式
 *
 * 单例：首次调用后复用同一实例。使用 reinitCacheStore 可强制重建。
 *
 * @param init 可选的初始化配置（来自配置文件 settings）
 */
export function createCacheStore(init?: CacheStoreInitOptions): CacheStore {
  if (currentStore) return currentStore;
  currentStore = buildStore(init);
  currentInitOptions = init ?? null;
  return currentStore;
}

/** 根据配置创建存储实例（不设单例） */
function buildStore(init?: CacheStoreInitOptions): CacheStore {
  const cacheType = init?.cacheType;
  const redisOptions = resolveRedisOptions(init);

  // 显式指定 redis，或未指定类型但环境变量配置了 Redis URL
  if (cacheType === "redis" || (!cacheType && redisOptions && process.env.MCP_REDIS_URL)) {
    if (redisOptions) {
      logger.info("启用 Redis 缓存模式", {
        keyPrefix: redisOptions.keyPrefix,
        tls: redisOptions.tls,
      });
      return new RedisCacheStore(redisOptions);
    }
    logger.warn("cache_type=redis 但未提供 Redis 配置，回退到内存模式");
  }

  logger.info("启用内存缓存模式");
  return new MemoryCacheStore();
}

/**
 * 重建缓存存储实例（切换缓存类型 / 修改 Redis 配置时调用）
 *
 * 关闭旧 store（释放连接/GC），按新配置创建新 store 并设为全局单例。
 * 内存模式自动启动 GC。
 */
export async function reinitCacheStore(init?: CacheStoreInitOptions): Promise<CacheStore> {
  if (currentStore?.close) {
    await currentStore.close();
  }
  currentStore = buildStore(init);
  currentInitOptions = init ?? null;

  // 内存模式启动 GC
  if (currentStore instanceof MemoryCacheStore) {
    currentStore.startGc();
  }
  logger.info("缓存存储已重建", { kind: currentStore.kind });
  return currentStore;
}

/** 获取当前缓存配置摘要（供 admin API 展示，Redis URL 脱敏） */
export function getCacheConfigSummary(): {
  kind: "memory" | "redis";
  redisUrl?: string;
  keyPrefix?: string;
  tls?: boolean;
} {
  if (!currentStore) {
    return { kind: "memory" };
  }
  if (currentStore.kind === "redis") {
    const opts = resolveRedisOptions(currentInitOptions ?? undefined);
    return {
      kind: "redis",
      redisUrl: opts?.url.replace(/\/\/.*@/, "//***@"),
      keyPrefix: opts?.keyPrefix,
      tls: opts?.tls,
    };
  }
  return { kind: "memory" };
}

/** 重置全局存储实例（测试用） */
export function resetCacheStore(): void {
  currentStore = null;
  currentInitOptions = null;
}

/** 获取当前全局存储实例（已初始化时） */
export function getCacheStore(): CacheStore | null {
  return currentStore;
}
