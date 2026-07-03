/**
 * 缓存存储层测试 — MemoryCacheStore / RedisCacheStore（注入 mock 客户端）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import type { OpenApiDocument } from "../types.js";
import {
  MemoryCacheStore,
  RedisCacheStore,
  parseRedisOptionsFromEnv,
  parseRedisUrl,
  reinitCacheStore,
  resetCacheStore,
  getCacheConfigSummary,
  createCacheStore,
  type CacheStore,
} from "./cache-store.js";

const sampleDoc: OpenApiDocument = {
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0" },
  paths: { "/users": { get: { summary: "list users" } } },
};

// ──────────────────────────────────────────────
// MemoryCacheStore
// ──────────────────────────────────────────────

describe("MemoryCacheStore", () => {
  let store: MemoryCacheStore;

  beforeEach(() => {
    store = new MemoryCacheStore();
  });

  it("set 后 get 命中同一文档", async () => {
    await store.set("proj_1", sampleDoc, 60_000);
    const got = await store.get("proj_1");
    expect(got).toEqual(sampleDoc);
  });

  it("未写入返回 undefined", async () => {
    expect(await store.get("not_exist")).toBeUndefined();
  });

  it("TTL 过期后 get 返回 undefined", async () => {
    vi.useFakeTimers();
    await store.set("proj_1", sampleDoc, 60_000);
    vi.advanceTimersByTime(61_000);
    expect(await store.get("proj_1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("delete 后 get 返回 undefined", async () => {
    await store.set("proj_1", sampleDoc, 60_000);
    await store.delete("proj_1");
    expect(await store.get("proj_1")).toBeUndefined();
  });

  it("clear 清空所有条目", async () => {
    await store.set("proj_1", sampleDoc, 60_000);
    await store.set("proj_2", sampleDoc, 60_000);
    await store.clear!();
    expect(await store.get("proj_1")).toBeUndefined();
    expect(await store.get("proj_2")).toBeUndefined();
  });

  it("GC 清理过期条目，保留有效条目", async () => {
    vi.useFakeTimers();
    store.startGc();
    await store.set("proj_1", sampleDoc, 60_000);
    // 推进到过期后，再触发 GC 扫描（10min 间隔）
    vi.advanceTimersByTime(61_000);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await store.get("proj_1")).toBeUndefined();
    store.stopGc();
    vi.useRealTimers();
  });

  it("kind 为 memory", () => {
    expect(store.kind).toBe("memory");
  });
});

// ──────────────────────────────────────────────
// RedisCacheStore（注入 mock 客户端，不依赖真实 Redis）
// ──────────────────────────────────────────────

/** 构造一个简易 mock redis 客户端 */
function createMockRedisClient() {
  const store = new Map<string, { value: string; ttlAt?: number }>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.ttlAt && entry.ttlAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, ...args: unknown[]): Promise<string> {
      // 支持 SET key value EX seconds
      const exIdx = args.indexOf("EX");
      let ttlAt: number | undefined;
      if (exIdx >= 0 && typeof args[exIdx + 1] === "number") {
        ttlAt = Date.now() + (args[exIdx + 1] as number) * 1000;
      }
      store.set(key, { value, ttlAt });
      return "OK";
    },
    async del(...keys: string[]): Promise<number> {
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n++;
      }
      return n;
    },
    async scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
      // 简化：忽略 cursor，返回所有匹配 key
      const matchIdx = args.indexOf("MATCH");
      const pattern = matchIdx >= 0 ? (args[matchIdx + 1] as string) : "*";
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      const keys: string[] = [];
      for (const k of store.keys()) {
        if (regex.test(k)) keys.push(k);
      }
      return ["0", keys];
    },
    on(_event: string, _cb: unknown): void {
      /* noop */
    },
    async quit(): Promise<string> {
      return "OK";
    },
  };
}

describe("RedisCacheStore", () => {
  let mockClient: ReturnType<typeof createMockRedisClient>;
  let store: RedisCacheStore;

  beforeEach(() => {
    mockClient = createMockRedisClient();
    store = new RedisCacheStore(
      { url: "redis://localhost:6379", keyPrefix: "api-mcp:cache:" },
      mockClient,
    );
  });

  it("kind 为 redis", () => {
    expect(store.kind).toBe("redis");
  });

  it("set 后 get 命中文档（JSON 序列化往返）", async () => {
    await store.set("proj_1", sampleDoc, 60_000);
    const got = await store.get("proj_1");
    expect(got).toEqual(sampleDoc);
  });

  it("使用 key 前缀存储", async () => {
    await store.set("proj_1", sampleDoc, 60_000);
    expect(mockClient.store.has("api-mcp:cache:proj_1")).toBe(true);
  });

  it("未命中返回 undefined", async () => {
    expect(await store.get("not_exist")).toBeUndefined();
  });

  it("delete 后 get 返回 undefined", async () => {
    await store.set("proj_1", sampleDoc, 60_000);
    await store.delete("proj_1");
    expect(await store.get("proj_1")).toBeUndefined();
  });

  it("set 传递 TTL（EX 秒数）", async () => {
    const setSpy = vi.spyOn(mockClient, "set");
    await store.set("proj_1", sampleDoc, 90_000); // 90s
    // 应以 EX 秒数调用
    expect(setSpy).toHaveBeenCalledWith(
      "api-mcp:cache:proj_1",
      expect.any(String),
      "EX",
      90,
    );
  });

  it("TTL 过期后 get 返回 undefined", async () => {
    vi.useFakeTimers();
    await store.set("proj_1", sampleDoc, 60_000);
    vi.advanceTimersByTime(61_000);
    expect(await store.get("proj_1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("clear 删除前缀下所有 key", async () => {
    await store.set("proj_1", sampleDoc, 60_000);
    await store.set("proj_2", sampleDoc, 60_000);
    await store.clear!();
    expect(await store.get("proj_1")).toBeUndefined();
    expect(await store.get("proj_2")).toBeUndefined();
  });

  it("get 出错时降级返回 undefined 而非抛出", async () => {
    const failingClient = {
      ...createMockRedisClient(),
      async get(): Promise<string> {
        throw new Error("connection lost");
      },
    };
    const failingStore = new RedisCacheStore(
      { url: "redis://localhost:6379" },
      failingClient,
    );
    expect(await failingStore.get("proj_1")).toBeUndefined();
  });

  it("set 出错时不抛出（仅告警）", async () => {
    const failingClient = {
      ...createMockRedisClient(),
      async set(): Promise<string> {
        throw new Error("write failed");
      },
    };
    const failingStore = new RedisCacheStore(
      { url: "redis://localhost:6379" },
      failingClient,
    );
    await expect(failingStore.set("proj_1", sampleDoc, 60_000)).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// 环境变量解析
// ──────────────────────────────────────────────

describe("parseRedisOptionsFromEnv", () => {
  it("未配置 MCP_REDIS_URL 返回 null", () => {
    delete process.env.MCP_REDIS_URL;
    expect(parseRedisOptionsFromEnv()).toBeNull();
  });

  it("配置后返回选项，默认前缀", () => {
    process.env.MCP_REDIS_URL = "redis://localhost:6379";
    delete process.env.MCP_REDIS_KEY_PREFIX;
    delete process.env.MCP_REDIS_TLS;
    const opts = parseRedisOptionsFromEnv();
    expect(opts).toEqual({
      url: "redis://localhost:6379",
      keyPrefix: "api-mcp:cache:",
      tls: false,
    });
  });

  it("rediss:// 自动启用 TLS", () => {
    process.env.MCP_REDIS_URL = "rediss://localhost:6379";
    const opts = parseRedisOptionsFromEnv();
    expect(opts?.tls).toBe(true);
  });

  it("自定义前缀生效", () => {
    process.env.MCP_REDIS_URL = "redis://localhost:6379";
    process.env.MCP_REDIS_KEY_PREFIX = "myapp:";
    const opts = parseRedisOptionsFromEnv();
    expect(opts?.keyPrefix).toBe("myapp:");
  });

  afterEach(() => {
    delete process.env.MCP_REDIS_URL;
    delete process.env.MCP_REDIS_KEY_PREFIX;
    delete process.env.MCP_REDIS_TLS;
  });
});

// ──────────────────────────────────────────────
// parseRedisUrl — URL 解析（兼容 Redis 5 仅 password 认证）
// ──────────────────────────────────────────────

describe("parseRedisUrl", () => {
  it("解析基本 host:port", () => {
    const opts = parseRedisUrl("redis://localhost:6379");
    expect(opts.host).toBe("localhost");
    expect(opts.port).toBe(6379);
    expect(opts.password).toBeUndefined();
  });

  it("仅含 password（Redis 5 格式 redis://:pass@host）", () => {
    const opts = parseRedisUrl("redis://:secret@localhost:6379");
    expect(opts.password).toBe("secret");
    expect(opts.host).toBe("localhost");
  });

  it("含 username + password 时丢弃 username（兼容 Redis 5）", () => {
    const opts = parseRedisUrl("redis://user:secret@localhost:6379");
    // username 被丢弃，仅保留 password → Redis 5 AUTH password 不会报错
    expect(opts.password).toBe("secret");
    expect(opts.username).toBeUndefined();
  });

  it("解析数据库序号 /1", () => {
    const opts = parseRedisUrl("redis://localhost:6379/2");
    expect(opts.db).toBe(2);
  });

  it("URL 编码的 password 正确解码", () => {
    const opts = parseRedisUrl("redis://:p%40ss@localhost:6379");
    expect(opts.password).toBe("p@ss");
  });

  it("tls=true 时附带 tls 选项", () => {
    const opts = parseRedisUrl("redis://localhost:6379", true);
    expect(opts.tls).toBeDefined();
  });

  it("无效 URL 回退为传 url 字段", () => {
    const opts = parseRedisUrl("not-a-url");
    expect(opts.url).toBe("not-a-url");
  });
});

// ──────────────────────────────────────────────
// CacheStore 接口契约一致性（两种实现都满足）
// ──────────────────────────────────────────────

const contractStores: { name: string; store: CacheStore }[] = [
  { name: "memory", store: new MemoryCacheStore() },
  {
    name: "redis",
    store: new RedisCacheStore(
      { url: "redis://localhost:6379" },
      createMockRedisClient(),
    ),
  },
];

describe("CacheStore 接口契约", () => {
  for (const { name, store } of contractStores) {
    it(`[${name}] set→get→delete 基本生命周期`, async () => {
      await store.set("proj_x", sampleDoc, 60_000);
      expect(await store.get("proj_x")).toEqual(sampleDoc);
      await store.delete("proj_x");
      expect(await store.get("proj_x")).toBeUndefined();
    });
  }
});

// ──────────────────────────────────────────────
// reinitCacheStore / getCacheConfigSummary
// ──────────────────────────────────────────────

describe("reinitCacheStore", () => {
  beforeEach(() => {
    resetCacheStore();
    delete process.env.MCP_REDIS_URL;
  });

  it("从 memory 切换到 redis（注入 mock 客户端）", async () => {
    // 先创建 memory store
    const memStore = createCacheStore({ cacheType: "memory" });
    expect(memStore.kind).toBe("memory");

    // reinit 为 redis
    const redisStore = await reinitCacheStore({
      cacheType: "redis",
      redis: { url: "redis://localhost:6379" },
    });
    expect(redisStore.kind).toBe("redis");
  });

  it("reinit 会 close 旧 store", async () => {
    const memStore = createCacheStore({ cacheType: "memory" }) as MemoryCacheStore;
    memStore.startGc();
    const closeSpy = vi.spyOn(memStore, "close");

    await reinitCacheStore({ cacheType: "memory" });
    expect(closeSpy).toHaveBeenCalled();
  });
});

describe("getCacheConfigSummary", () => {
  beforeEach(() => {
    resetCacheStore();
    delete process.env.MCP_REDIS_URL;
  });

  it("memory 模式返回 memory 摘要", () => {
    createCacheStore({ cacheType: "memory" });
    const summary = getCacheConfigSummary();
    expect(summary.kind).toBe("memory");
  });

  it("redis 模式返回脱敏 url", () => {
    createCacheStore({
      cacheType: "redis",
      redis: { url: "redis://:secret@localhost:6379", keyPrefix: "test:" },
    });
    const summary = getCacheConfigSummary();
    expect(summary.kind).toBe("redis");
    expect(summary.keyPrefix).toBe("test:");
    // 密码被脱敏
    expect(summary.redisUrl).toContain("***");
    expect(summary.redisUrl).not.toContain("secret");
  });
});
