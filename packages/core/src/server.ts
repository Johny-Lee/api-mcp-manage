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
import { startCacheGc, stopCacheGc, invalidateProject, getProjectDoc } from "./swagger/cache.js";
import { filterApiList } from "./swagger/format.js";
import { logger } from "./utils/logger.js";
import type { McpProjectsConfig } from "./types.js";
import { loadConfig, addProject, updateProject, removeProject, resetMcpToken, generateAdminSessionToken } from "./config/index.js";

// ──────────────────────────────────────────────
// 全局状态
// ──────────────────────────────────────────────
let config: McpProjectsConfig;
let mcpServer: McpServer;
let adminSessionToken: string;
let currentPort: number;
let httpServer: HttpServer | null = null;

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
export async function startServer(options: {
  port?: number;
  configPath?: string;
  webDistPath?: string;
  skipWeb?: boolean;
} = {}): Promise<{ port: number; adminSessionToken: string; mcpClientToken: string }> {
  // 加载配置
  config = await loadConfig(options.configPath);
  adminSessionToken = generateAdminSessionToken();

  // 缓存 GC
  startCacheGc();

  // 创建 MCP Server
  mcpServer = new McpServer({
    name: "api-mcp-manager",
    version: "1.3.0",
  });

  // 注册工具（动态读取配置，支持热更新）
  registerTools(mcpServer, () => config);

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
  // Stateless 模式：每次请求创建新的 transport 实例
  // ──────────────────────────────────────────
  const staticKeyAuth = new StaticKeyAuthProvider(() => config);

  app.post("/mcp", async (req, res) => {
    await staticKeyAuth.validate(req, res, async () => {
      const reqTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await mcpServer.connect(reqTransport);
        await reqTransport.handleRequest(req, res, req.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : "";
        logger.error("MCP 请求处理异常", { error: msg, stack: stack?.split("\n").slice(0, 3).join(" | ") });
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal MCP error", detail: msg });
        }
      } finally {
        await reqTransport.close().catch(() => {});
      }
    });
  });

  // SSE 升级（GET /mcp — stateless 模式每次新 transport）
  app.get("/mcp", async (req, res) => {
    await staticKeyAuth.validate(req, res, async () => {
      const reqTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await mcpServer.connect(reqTransport);
        await reqTransport.handleRequest(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("MCP SSE 请求异常", { error: msg });
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal MCP error", detail: msg });
        }
      } finally {
        await reqTransport.close().catch(() => {});
      }
    });
  });

  // ──────────────────────────────────────────
  // Admin API 端点
  // ──────────────────────────────────────────
  const adminAuth = createAdminAuth(adminSessionToken);

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
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
    res.json(projects);
  });

  // 添加项目
  app.post("/admin/api/projects", adminAuth, async (req, res) => {
    try {
      const { name, desc, source, url, baseUrl, projectId, token } = req.body;
      if (!name) {
        res.status(400).json({ error: "name 为必填字段" });
        return;
      }
      const result = await addProject(
        config,
        { name, desc: desc || "", source, url, baseUrl, projectId, token },
        options.configPath,
      );
      config = result.config;
      mcpServer.sendToolListChanged();
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
      const { name, desc, source, url, baseUrl, projectId, token } = req.body;
      const patch: Record<string, string | undefined> = {};
      if (name !== undefined) patch.name = name;
      if (desc !== undefined) patch.desc = desc;
      if (source !== undefined) patch.source = source;
      if (url !== undefined) patch.url = url;
      if (baseUrl !== undefined) patch.baseUrl = baseUrl;
      if (projectId !== undefined) patch.projectId = projectId;
      if (token !== undefined) patch.token = token;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "无更新字段" });
        return;
      }
      config = await updateProject(config, id, patch as never, options.configPath);
      invalidateProject(id);
      mcpServer.sendToolListChanged();
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
      invalidateProject(id);
      mcpServer.sendToolListChanged();
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
      invalidateProject(project.id);
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

  // 安全设置
  app.get("/admin/api/security", adminAuth, (_req, res) => {
    res.json({
      mcpClientToken: config.settings.mcp_client_token,
      port: currentPort,
      mcpEndpoint: `/mcp`,
    });
  });

  app.post("/admin/api/security/reset-token", adminAuth, async (_req, res) => {
    const result = await resetMcpToken(config, options.configPath);
    config = result.config;
    res.json({ newToken: result.newToken });
  });

  // 启动横幅信息
  app.get("/admin/api/info", adminAuth, (_req, res) => {
    res.json({
      version: "1.3.0",
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
      "🚀 API MCP Manager Server (V1.3) 已启动！",
      "─────────────────────────────────────────────────────",
      `📡 MCP Endpoint (Streamable HTTP):  http://localhost:${currentPort}/mcp`,
      `🛠️  Web Dashboard:                   http://localhost:${currentPort}/admin?token=${adminSessionToken}`,
      `🔑 MCP Client Token:                 ${config.settings.mcp_client_token}`,
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
  stopCacheGc();
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
  logger.info("服务器已关闭");
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
