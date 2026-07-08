import type { Request, Response, NextFunction } from "express";
import type { McpProjectsConfig } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * 鉴权提供者接口 — 支持后续扩展 OAuth 2.1
 *
 * V1.3 实现 StaticKeyAuthProvider（静态 API Key）
 * 预留 OAuth21AuthProvider 空骨架供公网多租户场景接入
 */

export interface AuthProvider {
  /** 验证请求，返回 true 表示通过 */
  validate(req: Request, res: Response, next: NextFunction): Promise<void>;
}

/** 鉴权上下文 */
export interface AuthContext {
  provider: string;
  keyId?: string;
}

/**
 * 静态 API Key 鉴权提供者
 *
 * 支持三种传参方式（优先级从高到低）：
 * 1. Authorization: Bearer <key>
 * 2. X-MCP-Token: <key>
 * 3. ?token=<key>（降级，打 warning）
 */
export class StaticKeyAuthProvider implements AuthProvider {
  constructor(private getConfig: () => McpProjectsConfig) {}

  async validate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const config = this.getConfig();
    const configuredToken = config.settings.mcp_client_token;
    if (!configuredToken) {
      // 未配置 token 时放行（开发模式）
      logger.warn("MCP 客户端 Token 未配置，放行所有请求（不安全）");
      (req as unknown as Record<string, unknown>).authContext = {
        provider: "static-key",
        keyId: "unconfigured",
      };
      next();
      return;
    }

    const authHeader = req.headers["authorization"];
    const tokenFromHeader = authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;
    const tokenFromXHeader = req.headers["x-mcp-token"] as string | undefined;
    const tokenFromQuery = req.query.token as string | undefined;

    const clientToken = tokenFromHeader || tokenFromXHeader || tokenFromQuery;

    if (!clientToken) {
      logger.warn("未提供 MCP 鉴权凭据", { ip: req.ip, path: req.path });
      res.status(401).json({ error: "Unauthorized: Missing MCP client token" });
      return;
    }

    if (clientToken !== configuredToken) {
      logger.warn("MCP 鉴权失败 — Token 不匹配", { ip: req.ip });
      res.status(401).json({ error: "Unauthorized: Invalid MCP client token" });
      return;
    }

    if (tokenFromQuery) {
      logger.warn(
        "Token 通过 URL Query 参数传入（不推荐，可能泄露至访问日志与浏览器历史）",
        { ip: req.ip },
      );
    }

    // 注入鉴权上下文，供后续使用
    (req as unknown as Record<string, unknown>).authContext = {
      provider: "static-key",
      keyId: configuredToken.slice(0, 8) + "...",
    };
    next();
  }
}

/**
 * OAuth 2.1 鉴权提供者（预留骨架，待实现）
 *
 * 需实现：
 * - PKCE (RFC 7636)
 * - Protected Resource Metadata (RFC 9728) → GET /.well-known/oauth-protected-resource
 * - Authorization Server Metadata (RFC 8414) → discovery
 * - Dynamic Client Registration (RFC 7591)
 * - Bearer token validation per RFC 6750
 *
 * 当前为预留骨架：直接抛错，避免被误装为放行后门。
 * 待实现完整流程后替换 validate 逻辑。
 */
export class OAuth21AuthProvider implements AuthProvider {
  async validate(_req: Request, _res: Response, _next: NextFunction): Promise<void> {
    throw new Error("OAuth21AuthProvider 尚未实现，请勿在未完成前挂载使用");
  }
}

/**
 * Admin Session Token 鉴权
 *
 * 启动时生成一次性 session token，通过 URL query 下发给管理后台。
 * 前端首屏读取后存 sessionStorage，后续请求带 X-Admin-Token header。
 * 仅允许 localhost/回环地址走 query 下发。
 *
 * 采用 getter 注入（而非按值捕获），保证运行期 token 变更（如切换持久化）
 * 能即时生效，无需重建中间件。
 */
export function createAdminAuth(getAdminSessionToken: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Admin 相关路径才需要鉴权
    if (!req.path.startsWith("/admin/api/")) {
      next();
      return;
    }

    const token = (req.headers["x-admin-token"] as string) || (req.query.token as string);

    // 仅回环地址允许 query token 下发
    const isLoopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1" || req.ip === "localhost";
    if (req.query.token && !isLoopback) {
      res.status(403).json({ error: "Forbidden: Admin token via URL only allowed on loopback" });
      return;
    }

    if (!token || token !== getAdminSessionToken()) {
      res.status(401).json({ error: "Unauthorized: Invalid admin session token" });
      return;
    }
    next();
  };
}
