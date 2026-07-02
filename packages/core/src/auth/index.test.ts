/**
 * 鉴权中间件测试 — 静态 Key 三种传参 + Admin 鉴权 + loopback 限制
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { StaticKeyAuthProvider, createAdminAuth } from "./index.js";
import type { McpProjectsConfig } from "../types.js";

const sampleConfig: McpProjectsConfig = {
  schemaVersion: 1,
  settings: { mcp_client_token: "mcp_key_test123", admin_port: 3001 },
  projects: [],
};

/** 构造测试用 express app 并发起请求 */
async function runAuthTest(middleware: express.RequestHandler, headers: Record<string, string>, query: Record<string, string> = {}, ip = "127.0.0.1"): Promise<number> {
  const app = express();
  app.use(middleware);
  app.use((_req, res) => res.status(200).json({ ok: true }));

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const url = new URL(`http://localhost:${port}/admin/api/projects`);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      fetch(url, { headers }).then(
        (r) => { server.close(); resolve(r.status); },
        () => { server.close(); resolve(0); },
      );
    });
  });
}

function makeReq(ip = "127.0.0.1") {
  return {
    ip,
    path: "/test",
    headers: {} as Record<string, string>,
    query: {} as Record<string, string>,
  } as unknown as express.Request;
}
function makeRes() {
  const status = vi.fn();
  const json = vi.fn();
  return {
    status: vi.fn().mockReturnValue({ json }),
    json,
  } as unknown as express.Response;
}

describe("StaticKeyAuthProvider", () => {
  const provider = new StaticKeyAuthProvider(() => sampleConfig);

  it("Bearer token 鉴权通过", async () => {
    const status = await runAuthTest(
      async (req, res, next) => provider.validate(req, res, next),
      { Authorization: "Bearer mcp_key_test123" },
    );
    expect(status).toBe(200);
  });

  it("X-MCP-Token 鉴权通过", async () => {
    const status = await runAuthTest(
      async (req, res, next) => provider.validate(req, res, next),
      { "X-MCP-Token": "mcp_key_test123" },
    );
    expect(status).toBe(200);
  });

  it("错误 token 被拒绝 (401)", async () => {
    const req = makeReq();
    const res = makeRes();
    req.headers = { authorization: "Bearer wrong" };
    await provider.validate(req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("无 token 被拒绝 (401)", async () => {
    const req = makeReq();
    const res = makeRes();
    req.headers = {};
    await provider.validate(req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("createAdminAuth", () => {
  const adminAuth = createAdminAuth("Session_admin123");

  it("正确 admin token 通过", async () => {
    const status = await runAuthTest(
      adminAuth,
      { "X-Admin-Token": "Session_admin123" },
    );
    expect(status).toBe(200);
  });

  it("错误 admin token 拒绝 (401)", async () => {
    const status = await runAuthTest(
      adminAuth,
      { "X-Admin-Token": "wrong" },
    );
    expect(status).toBe(401);
  });

  it("非 admin 路径放行", () => {
    const req = makeReq();
    req.path = "/mcp";
    let called = false;
    adminAuth(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
  });

  it("loopback 允许 query token", async () => {
    const status = await runAuthTest(
      adminAuth,
      {},
      { token: "Session_admin123" },
      "127.0.0.1",
    );
    expect(status).toBe(200);
  });

  it("非 loopback 拒绝 query token (403)", async () => {
    const app = express();
    app.use((req, _res, next) => {
      // 模拟非回环 IP
      Object.defineProperty(req, "ip", { value: "192.168.1.5" });
      next();
    });
    app.use(createAdminAuth("Session_admin123"));
    app.use((_req, res) => res.status(200).json({ ok: true }));

    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = (server.address() as { port: number }).port;
        fetch(`http://localhost:${port}/admin/api/test?token=Session_admin123`).then(
          (r) => { server.close(); resolve(expect(r.status).toBe(403)); },
          () => { server.close(); },
        );
      });
    });
  });
});
