import express from "express";
import cors from "cors";
import { createServer, type Server as HttpServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools/index.js";
import { StaticKeyAuthProvider, createAdminAuth } from "./auth/index.js";
import { startCacheGc, stopCacheGc, invalidateProject, getProjectDoc, getCacheKind, reinitCache, testRedis, clearCache } from "./swagger/cache.js";
import { getCacheConfigSummary } from "./swagger/cache-store.js";
import { VERSION, BANNER_VERSION } from "./version.js";
import { filterApiList, formatApiDetail, formatNotFound } from "./swagger/format.js";
import { parseImportedDoc } from "./swagger/import.js";
import { derefOperation } from "./tools/index.js";
import { fetchYapiProjectDetail, isYapiProject } from "./swagger/yapi.js";
import { extractApifoxEnvs, isApifoxProject } from "./swagger/apifox.js";
import type { OpenApiDocumentLike } from "./swagger/types-helpers.js";
import type { OpenApiOperation } from "./types.js";
import { logger } from "./utils/logger.js";
import type { McpProjectsConfig } from "./types.js";
import { loadConfig, saveConfig, addProject, updateProject, removeProject, resetMcpToken, generateAdminSessionToken, updateCacheSettings, setImportedDoc, updateAdminTokenPersistence, type CacheSettingsPatch } from "./config/index.js";

// ──────────────────────────────────────────────
// 全局状态
// ──────────────────────────────────────────────
let config: McpProjectsConfig;
let adminSessionToken: string;
let currentPort: number;
let httpServer: HttpServer | null = null;
/** 记录启动参数，供 restartServer 复用 */
let startOptions: StartServerOptions = {};

/**
 * 按请求创建独立的 McpServer 实例。
 *
 * Streamable HTTP 的 stateless 模式（sessionIdGenerator: undefined）下，每个请求
 * 必须拥有独立的协议状态：一个 McpServer 只能 connect 到一个 transport，再次 connect
 * 会抛 "Already connected to a transport..."。因此不能复用全局 server，而要在每个
 * 请求内新建 server + transport，请求结束后各自 close。
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "api-mcp-manager",
    version: VERSION,
  });
  // 注册工具（动态读取配置，支持热更新）
  registerTools(server, () => config);
  return server;
}

// ──────────────────────────────────────────────
// 端口自适应探测
// ──────────────────────────────────────────────
async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.unref();
      s.on("error", () => resolve(false));
      s.listen(port, () => {
        s.close(() => resolve(true));
      });
    });
    if (ok) return port;
  }
  throw new Error("无法找到可用端口（3001-3100 均被占用）");
}

// ──────────────────────────────────────────────
// 服务器初始化
// ──────────────────────────────────────────────
export interface StartServerOptions {
  port?: number;
  configPath?: string;
  webDistPath?: string;
  skipWeb?: boolean;
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<{ port: number; adminSessionToken: string; mcpClientToken: string }> {
  startOptions = options;

  // 加载配置
  config = await loadConfig(options.configPath);

  // Web 后台访问 Token：
  // - 进程内重启（restartServer）复用已存在的 adminSessionToken，避免踢掉已登录用户
  // - 持久化模式（persist_admin_token=true）：从配置读取持久 token，缺失则生成并保存
  // - 默认（非持久化）：每次进程启动重新生成
  if (adminSessionToken) {
    // 进程内重启：复用（无需持久化校验，token 已在内存中）
  } else if (config.settings.persist_admin_token) {
    if (config.settings.admin_session_token) {
      adminSessionToken = config.settings.admin_session_token;
    } else {
      // 首次开启持久化但尚未生成 token：生成并持久化
      adminSessionToken = generateAdminSessionToken();
      config.settings.admin_session_token = adminSessionToken;
      await saveConfig(config, options.configPath);
    }
  } else {
    adminSessionToken = generateAdminSessionToken();
  }

  // 根据配置初始化缓存（内存/Redis + TTL）
  await reinitCache(config.settings);
  startCacheGc();
  const cacheMode = getCacheKind() === "redis" ? "Redis" : "Memory";

  // ──────────────────────────────────────────
  // Express 应用
  // ──────────────────────────────────────────
  const app = express();

  // Body 解析（JSON for MCP messages, urlencoded for admin）
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // CORS（动态读取实际端口）
  const startPort = options.port || config.settings.admin_port;
  currentPort = await findAvailablePort(startPort);
  const origin = `http://localhost:${currentPort}`;

  app.use(
    cors({
      origin: [origin, "http://localhost:5173"], // dev 时 Vite 端口
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-MCP-Token", "X-Admin-Token"],
    }),
  );

  // ──────────────────────────────────────────
  // MCP Streamable HTTP 端点 POST /mcp
  // Stateless 模式：每次请求创建新的 server + transport 实例
  // ──────────────────────────────────────────
  const staticKeyAuth = new StaticKeyAuthProvider(() => config);

  app.post("/mcp", async (req, res) => {
    await staticKeyAuth.validate(req, res, async () => {
      // Stateless 模式：每次请求创建新的 server + transport 实例
      const server = createMcpServer();
      const reqTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await server.connect(reqTransport);
        await reqTransport.handleRequest(req, res, req.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : "";
        logger.error("MCP 请求处理异常", { error: msg, stack: stack?.split("\n").slice(0, 3).join(" | ") });
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal MCP error", detail: msg });
        }
      } finally {
        // 请求级实例，结束后各自关闭
        await reqTransport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    });
  });

  // SSE 升级（GET /mcp — stateless 模式每次新 server + transport）
  app.get("/mcp", async (req, res) => {
    await staticKeyAuth.validate(req, res, async () => {
      const server = createMcpServer();
      const reqTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await server.connect(reqTransport);
        await reqTransport.handleRequest(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("MCP SSE 请求异常", { error: msg });
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal MCP error", detail: msg });
        }
      } finally {
        await reqTransport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    });
  });

  // ──────────────────────────────────────────
  // Admin API 端点
  // ──────────────────────────────────────────
  const adminAuth = createAdminAuth(() => adminSessionToken);

  // 获取所有项目
  app.get("/admin/api/projects", adminAuth, (_req, res) => {
    const projects = config.projects.map((p: McpProjectsConfig["projects"][number]) => ({
      id: p.id,
      name: p.name,
      desc: p.desc,
      source: p.source || "swagger",
      url: p.url,
      baseUrl: p.baseUrl,
      projectId: p.projectId,
      hasToken: !!p.token,
      importMode: !!p.importMode,
      hasImportedDoc: !!p.importedDoc,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
    res.json(projects);
  });

  // 添加项目
  app.post("/admin/api/projects", adminAuth, async (req, res) => {
    try {
      const { name, desc, source, url, baseUrl, projectId, token, importMode } = req.body;
      if (!name) {
        res.status(400).json({ error: "name 为必填字段" });
        return;
      }
      const result = await addProject(
        config,
        { name, desc: desc || "", source, url, baseUrl, projectId, token, importMode: !!importMode },
        options.configPath,
      );
      config = result.config;
      res.status(201).json(result.project);
    } catch (err) {
      logger.error("添加项目失败", { error: String(err) });
      res.status(400).json({ error: errMsg(err) });
    }
  });

  // 更新项目
  app.patch("/admin/api/projects/:id", adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, desc, source, url, baseUrl, projectId, token, importMode } = req.body;
      const patch: Record<string, unknown> = {};
      if (name !== undefined) patch.name = name;
      if (desc !== undefined) patch.desc = desc;
      if (source !== undefined) patch.source = source;
      if (url !== undefined) patch.url = url;
      if (baseUrl !== undefined) patch.baseUrl = baseUrl;
      if (projectId !== undefined) patch.projectId = projectId;
      if (token !== undefined) patch.token = token;
      if (importMode !== undefined) patch.importMode = !!importMode;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "无更新字段" });
        return;
      }
      config = await updateProject(config, id, patch as never, options.configPath);
      await invalidateProject(id);
      res.json({ ok: true });
    } catch (err) {
      logger.error("更新项目失败", { error: String(err) });
      res.status(400).json({ error: errMsg(err) });
    }
  });

  // 删除项目
  app.delete("/admin/api/projects/:id", adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      config = await removeProject(config, id, options.configPath);
      await invalidateProject(id);
      res.json({ ok: true });
    } catch (err) {
      logger.error("删除项目失败", { error: String(err) });
      res.status(500).json({ error: errMsg(err) });
    }
  });

  // 测试连接
  app.post("/admin/api/projects/:id/test", adminAuth, async (req, res) => {
    try {
      const project = config.projects.find((p: McpProjectsConfig["projects"][number]) => p.id === req.params.id);
      if (!project) {
        res.status(404).json({ error: "项目不存在" });
        return;
      }
      await invalidateProject(project.id);
      const doc = await getProjectDoc(project);
      res.json({
        ok: true,
        title: doc.info.title,
        pathCount: Object.keys(doc.paths).length,
        version: doc.info.version,
      });
    } catch (err) {
      res.json({ ok: false, error: errMsg(err) });
    }
  });

  // 刷新项目缓存（手动触发重新拉取）
  app.post("/admin/api/projects/:id/refresh", adminAuth, async (req, res) => {
    try {
      const project = config.projects.find((p: McpProjectsConfig["projects"][number]) => p.id === req.params.id);
      if (!project) {
        res.status(404).json({ error: "项目不存在" });
        return;
      }
      // 导入 JSON 模式无上游，不支持刷新缓存
      if (project.importMode) {
        res.json({ ok: false, error: "导入 JSON 项目无需刷新缓存，请使用「导入 JSON」重新导入" });
        return;
      }
      // 先失效缓存，再立即拉取最新文档
      await invalidateProject(project.id);
      const doc = await getProjectDoc(project);
      res.json({
        ok: true,
        title: doc.info.title,
        pathCount: Object.keys(doc.paths).length,
        version: doc.info.version,
      });
    } catch (err) {
      logger.error("刷新缓存失败", { projectId: req.params.id, error: String(err) });
      res.json({ ok: false, error: errMsg(err) });
    }
  });

  // 导入 JSON 文档（仅导入模式项目可用）
  app.post("/admin/api/projects/:id/import", adminAuth, async (req, res) => {
    try {
      const project = config.projects.find((p: McpProjectsConfig["projects"][number]) => p.id === req.params.id);
      if (!project) {
        res.status(404).json({ error: "项目不存在" });
        return;
      }
      if (!project.importMode) {
        res.status(400).json({ error: "该项目非导入 JSON 模式，请先在编辑中切换为导入 JSON" });
        return;
      }
      const json = typeof req.body?.json === "string" ? req.body.json : "";
      if (!json.trim()) {
        res.status(400).json({ error: "json 内容为空" });
        return;
      }
      // 按 source 类型校验并转换为 OpenApiDocument
      const source = project.source || "swagger";
      const doc = parseImportedDoc(source, json, project.name);
      // 持久化导入文档
      config = await setImportedDoc(config, project.id, doc, options.configPath);
      // 失效缓存，使下次访问读取新的 importedDoc
      await invalidateProject(project.id);
      res.json({
        ok: true,
        title: doc.info.title,
        pathCount: Object.keys(doc.paths).length,
        version: doc.info.version,
      });
    } catch (err) {
      logger.error("导入 JSON 失败", { projectId: req.params.id, error: String(err) });
      res.json({ ok: false, error: errMsg(err) });
    }
  });

  // 获取项目接口列表（供后台「点进项目看接口」）
  app.get("/admin/api/projects/:id/apis", adminAuth, async (req, res) => {
    try {
      const project = config.projects.find((p: McpProjectsConfig["projects"][number]) => p.id === req.params.id);
      if (!project) {
        res.status(404).json({ error: "项目不存在" });
        return;
      }
      const keyword = (req.query.keyword as string) || undefined;
      const doc = await getProjectDoc(project);
      const filtered = filterApiList(doc, keyword);
      // 展平为 {method, path, summary, deprecated} 列表
      const apis: { method: string; path: string; summary: string; deprecated: boolean }[] = [];
      for (const [path, methods] of Object.entries(filtered.paths)) {
        for (const [method, op] of Object.entries(methods)) {
          const ml = method.toLowerCase();
          if (!["get", "post", "put", "delete", "patch", "options", "head"].includes(ml)) continue;
          apis.push({
            method: ml.toUpperCase(),
            path,
            summary: op.summary || op.operationId || "",
            deprecated: !!op.deprecated,
          });
        }
      }
      res.json({ title: doc.info.title, count: apis.length, apis });
    } catch (err) {
      logger.error("获取接口列表失败", { error: String(err) });
      res.status(500).json({ error: errMsg(err) });
    }
  });

  // 获取单个接口详情 Markdown（供后台「点进接口看详情」）
  // 复用 get_api_details MCP 工具的底层函数，保证单一数据源
  app.get("/admin/api/projects/:id/apis/detail", adminAuth, async (req, res) => {
    try {
      const project = config.projects.find((p: McpProjectsConfig["projects"][number]) => p.id === req.params.id);
      if (!project) {
        res.status(404).json({ error: "项目不存在" });
        return;
      }
      const path = (req.query.path as string) || "";
      const method = ((req.query.method as string) || "").toLowerCase();
      if (!path || !method) {
        res.status(400).json({ error: "path 与 method 为必填参数" });
        return;
      }

      const doc = await getProjectDoc(project);
      const pathItem = doc.paths[path];
      const op = pathItem ? (pathItem[method] as OpenApiOperation | undefined) : undefined;
      if (!pathItem || !op) {
        // 接口不存在：返回友好提示 markdown（HTTP 200，前端按 markdown 渲染）
        res.json({ markdown: formatNotFound(project.name, path, method) });
        return;
      }

      // 局部 $ref 解引用后格式化为 Markdown（与 get_api_details 工具一致）
      const derefedOp = derefOperation(op, doc as unknown as OpenApiDocumentLike);

      // YApi 源项目：拉取项目详情获取环境域名，在接口详情中展示
      // Apifox 源：从已拉取文档的 servers 字段提取环境域名
      // 导入 JSON 模式无 baseUrl/token，跳过
      let envs;
      if (isYapiProject(project) && !project.importMode) {
        try {
          const detail = await fetchYapiProjectDetail(project);
          envs = detail.env;
        } catch (err) {
          logger.warn("接口详情拉取项目环境域名失败", { projectId: project.id, error: String(err) });
        }
      } else if (isApifoxProject(project) && !project.importMode) {
        envs = extractApifoxEnvs(doc);
      }

      const markdown = formatApiDetail(project.name, path, method, derefedOp, envs);
      res.json({ markdown });
    } catch (err) {
      logger.error("获取接口详情失败", { error: String(err) });
      res.status(500).json({ error: errMsg(err) });
    }
  });

  // 安全设置
  app.get("/admin/api/security", adminAuth, (_req, res) => {
    const cacheSummary = getCacheConfigSummary();
    res.json({
      mcpClientToken: config.settings.mcp_client_token,
      port: currentPort,
      mcpEndpoint: `/mcp`,
      version: VERSION,
      persistAdminToken: !!config.settings.persist_admin_token,
      cache: {
        type: config.settings.cache_type || "memory",
        ttlMs: config.settings.cache_ttl_ms,
        redis: config.settings.cache_redis
          ? {
              url: config.settings.cache_redis.url.replace(/\/\/.*@/, "//***@"),
              keyPrefix: config.settings.cache_redis.keyPrefix,
              tls: config.settings.cache_redis.tls,
            }
          : undefined,
        activeKind: cacheSummary.kind,
      },
    });
  });

  app.post("/admin/api/security/reset-token", adminAuth, async (_req, res) => {
    const result = await resetMcpToken(config, options.configPath);
    config = result.config;
    res.json({ newToken: result.newToken });
  });

  // 切换 Web 后台访问 Token 持久化设置
  // 开启时优先沿用当前内存 token 并持久化（保证当前会话重启后仍有效），
  // 关闭时清除持久 token。切换后当前进程同步更新内存 token。
  app.put("/admin/api/security/persist-admin-token", adminAuth, async (req, res) => {
    try {
      const persist = !!req.body?.persist;
      const result = await updateAdminTokenPersistence(config, persist, options.configPath, adminSessionToken);
      config = result.config;
      // 同步内存 token：开启时沿用持久化 token，关闭时保持当前 token 不变（下次启动才换新）
      if (persist && result.adminSessionToken) {
        adminSessionToken = result.adminSessionToken;
      }
      res.json({ ok: true, persistAdminToken: persist });
    } catch (err) {
      logger.error("切换 Token 持久化失败", { error: String(err) });
      res.status(400).json({ error: errMsg(err) });
    }
  });

  // 测试缓存连接（仅 Redis 需要测试，不保存配置）
  app.post("/admin/api/cache-settings/test", adminAuth, async (req, res) => {
    try {
      const { cache_type, cache_redis } = req.body || {};
      if (cache_type !== "redis") {
        // memory 模式无需测试，直接通过
        res.json({ ok: true });
        return;
      }
      if (!cache_redis?.url) {
        res.json({ ok: false, error: "Redis 连接地址未配置" });
        return;
      }
      const result = await testRedis({
        mcp_client_token: "",
        admin_port: 0,
        cache_type: "redis",
        cache_redis,
      });
      res.json(result);
    } catch (err) {
      res.json({ ok: false, error: errMsg(err) });
    }
  });

  // 更新缓存设置（保存配置 → 清缓存 → 重启服务）
  app.put("/admin/api/cache-settings", adminAuth, async (req, res) => {
    try {
      const patch: CacheSettingsPatch = {};
      const { cache_type, cache_ttl_ms, cache_redis } = req.body || {};
      if (cache_type !== undefined) patch.cache_type = cache_type;
      if (cache_ttl_ms !== undefined) patch.cache_ttl_ms = cache_ttl_ms;
      if (cache_redis !== undefined) patch.cache_redis = cache_redis;

      config = await updateCacheSettings(config, patch, options.configPath);
      logger.info("缓存设置已更新，准备重启服务", { cacheType: config.settings.cache_type });

      // 清除当前缓存
      await clearCache();

      res.json({
        ok: true,
        message: "缓存设置已保存，服务正在重启",
        cache: {
          type: config.settings.cache_type || "memory",
          ttlMs: config.settings.cache_ttl_ms,
        },
      });

      // 异步重启服务（不阻塞响应）
      restartServer().catch((err) => {
        logger.error("重启服务失败", { error: String(err) });
      });
    } catch (err) {
      logger.error("更新缓存设置失败", { error: String(err) });
      res.status(400).json({ error: errMsg(err) });
    }
  });

  // 启动横幅信息
  app.get("/admin/api/info", adminAuth, (_req, res) => {
    res.json({
      version: VERSION,
      port: currentPort,
      projectCount: config.projects.length,
    });
  });

  // ──────────────────────────────────────────
  // Web 静态文件托管
  // ──────────────────────────────────────────
  if (!options.skipWeb) {
    const webDist = options.webDistPath || resolveWebDist();
    app.use(express.static(webDist, { index: false }));
    // SPA fallback
    app.get("*", (_req, res) => {
      const indexPath = join(webDist, "index.html");
      res.sendFile(indexPath, (err) => {
        if (err) {
          // index.html 不存在时（纯 CLI 模式），返回简单文本
          res.status(200).send("API MCP Manager - Web Dashboard not built. Use the CLI or build the web package.");
        }
      });
    });
  }

  // ──────────────────────────────────────────
  // 启动 HTTP Server
  // ──────────────────────────────────────────
  httpServer = app.listen(currentPort, () => {
    // 控制台启动横幅
    const banner = [
      "",
      `🚀 API MCP Manager Server (${BANNER_VERSION}) 已启动！`,
      "─────────────────────────────────────────────────────",
      `📡 MCP Endpoint (Streamable HTTP):  http://localhost:${currentPort}/mcp`,
      `🛠️  Web Dashboard:                   http://localhost:${currentPort}/admin?token=${adminSessionToken}`,
      `🔑 MCP Client Token:                 ${config.settings.mcp_client_token}`,
      `💾 缓存模式:                          ${cacheMode}`,
      "─────────────────────────────────────────────────────",
      "按 Ctrl+C 停止服务器",
      "",
    ].join("\n");
    console.log(banner);

    // 非回环访问时的 TLS 警告
    if (process.env.MCP_SKIP_TLS_WARNING !== "1") {
      const host = process.env.MCP_HOST || process.env.HOST || "localhost";
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        console.warn("⚠️  检测到非回环地址绑定。公网部署请务必通过 TLS 反代（Nginx/Caddy）保护 MCP 端点，否则 Token 可被嗅探。");
      }
    }
  });

  logger.info("服务器已启动", { port: currentPort });

  return {
    port: currentPort,
    adminSessionToken,
    mcpClientToken: config.settings.mcp_client_token,
  };
}

// ──────────────────────────────────────────────
// 服务器关闭
// ──────────────────────────────────────────────
export async function stopServer(): Promise<void> {
  logger.info("正在关闭服务器...");
  await stopCacheGc();
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }
  logger.info("服务器已关闭");
}

/**
 * 原地重启服务（用于缓存配置变更后生效）
 *
 * 停止旧 HTTP server → 重新 startServer（复用 adminSessionToken、端口、configPath）。
 * adminSessionToken 与 currentPort 保持不变，已登录用户无需重新认证。
 */
export async function restartServer(): Promise<void> {
  logger.info("正在重启服务...");
  // 停止缓存（关闭连接/GC）
  await stopCacheGc();
  // 关闭 HTTP server
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }
  // 重新启动（复用 adminSessionToken）
  await startServer(startOptions);
  logger.info("服务已重启", { port: currentPort });
}

// ──────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────

function resolveWebDist(): string {
  // 兼容 ESM / CJS / SEA 三种运行环境
  // SEA 下 import.meta.url 与 __dirname 均指向二进制，process.execPath 更可靠
  const binDir = dirname(process.execPath);
  const moduleDir = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return binDir;
    }
  })();
  const candidates = [
    // SEA：与二进制同目录的 assets/web
    join(binDir, "assets", "web"),
    // 开发/本地运行（core/dist 在 packages/core/dist）→ packages/web/dist
    join(moduleDir, "..", "..", "..", "packages", "web", "dist"),
    // core/dist 在 node_modules 内嵌套较深时兜底（cwd 为仓库根）
    join(process.cwd(), "packages", "web", "dist"),
    // 打包后：core/dist → core/public
    join(moduleDir, "..", "public"),
    // CLI 运行目录
    join(process.cwd(), "public"),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "index.html"))) {
      return p;
    }
  }
  return join(process.cwd(), "public");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
