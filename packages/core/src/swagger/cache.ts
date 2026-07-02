import type { McpProject, OpenApiDocument, SwaggerCacheEntry } from "../types.js";
import { fetchJson } from "../utils/http.js";
import { normalizeDocument } from "./normalize.js";
import { fetchYapiDocument, isYapiProject } from "./yapi.js";
import { logger } from "../utils/logger.js";

/**
 * Swagger 懒加载二级缓存
 *
 * 策略：
 * - 首次调用某项目时拉取并解析 Swagger，结果常驻内存
 * - TTL 默认 2 小时，过期后下次调用触发重新拉取
 * - 定时 GC 清理已过期条目
 */

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时
const GC_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟扫描一次

/** 内存缓存：projectId → entry */
const cache = new Map<string, SwaggerCacheEntry>();

/** 拉取中的进行中 Promise（防止并发重复拉取） */
const pending = new Map<string, Promise<OpenApiDocument>>();

let gcTimer: NodeJS.Timeout | null = null;

/** 启动 GC 定时器 */
export function startCacheGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of cache) {
      if (entry.expiresAt < now) {
        cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug("缓存 GC 完成", { cleaned, remaining: cache.size });
    }
  }, GC_INTERVAL_MS);
  // 不阻止进程退出
  if (gcTimer.unref) gcTimer.unref();
}

/** 停止 GC 定时器（测试 / 关闭用） */
export function stopCacheGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}

/** 清空缓存 */
export function clearCache(): void {
  cache.clear();
  pending.clear();
}

/** 从缓存获取（过期返回 undefined） */
export function getCached(projectId: string): OpenApiDocument | undefined {
  const entry = cache.get(projectId);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(projectId);
    return undefined;
  }
  return entry.doc;
}

/** 基本校验 OpenAPI/Swagger 文档结构 */
function validateOpenApi(doc: unknown): OpenApiDocument {
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
  const source = isYapiProject(project) ? "yapi" : "swagger";
  logger.info("拉取文档", { projectId: project.id, source });

  let doc: OpenApiDocument;
  if (source === "yapi") {
    // YApi 源：通过原生开放 API 拉取接口列表 + 详情，转换为 OpenApiDocument
    doc = await fetchYapiDocument(project);
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
  const cached = getCached(project.id);
  if (cached) return cached;

  // 2. 查进行中
  const inflight = pending.get(project.id);
  if (inflight) return inflight;

  // 3. 发起拉取
  const p = (async () => {
    try {
      const doc = await fetchAndParse(project);
      const now = Date.now();
      cache.set(project.id, {
        doc,
        cachedAt: now,
        expiresAt: now + DEFAULT_TTL_MS,
      });
      return doc;
    } finally {
      pending.delete(project.id);
    }
  })();
  pending.set(project.id, p);
  return p;
}

/** 主动使某项目缓存失效 */
export function invalidateProject(projectId: string): void {
  cache.delete(projectId);
  logger.debug("缓存已失效", { projectId });
}
