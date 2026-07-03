/**
 * 服务器集成测试 — MCP 端点 / Admin API / 鉴权闭环
 *
 * 起一个真实 Express server（ephemeral 端口），用 fetch 走完整协议。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer } from "./server.js";

let port: number;
let mcpToken: string;
let adminToken: string;
let baseUrl: string;
let tmpConfig: string;

/** 从 SSE 响应中提取 data: 行的 JSON */
function parseSse(raw: string): unknown {
  const m = raw.match(/^data: (.*)$/m);
  if (!m) throw new Error("No data line in SSE: " + raw.slice(0, 120));
  return JSON.parse(m[1]);
}

async function mcpCall(token: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: res.status === 200 ? parseSse(text) : text };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-server-test-"));
  tmpConfig = join(dir, "mcp-projects.json");
  const info = await startServer({ port: 0, configPath: tmpConfig, skipWeb: true });
  port = info.port;
  mcpToken = info.mcpClientToken;
  adminToken = info.adminSessionToken;
  baseUrl = `http://localhost:${port}`;
}, 30000);

afterAll(async () => {
  await stopServer();
  rmSync(join(tmpConfig, ".."), { recursive: true, force: true });
}, 30000);

describe("MCP 端点鉴权", () => {
  it("无 token → 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("错误 token → 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("X-MCP-Token 鉴权通过", async () => {
    const { status, data } = await mcpCall(mcpToken, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { Authorization: "", "X-MCP-Token": mcpToken });
    expect(status).toBe(200);
    const names = ((data as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name));
    expect(names).toEqual(["list_projects", "get_api_list", "get_api_details", "get_project_detail"]);
  });
});

describe("MCP 协议", () => {
  it("initialize 返回 serverInfo", async () => {
    const { status, data } = await mcpCall(mcpToken, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(status).toBe(200);
    expect((data as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("api-mcp-manager");
  });

  it("list_projects 返回空数组", async () => {
    const { status, data } = await mcpCall(mcpToken, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "list_projects", arguments: {} },
    });
    expect(status).toBe(200);
    const text = (data as { result: { content: { text: string }[] } }).result.content[0].text;
    expect(JSON.parse(text)).toEqual([]);
  });

  it("get_api_list 不存在的项目 → 错误 Markdown", async () => {
    const { status, data } = await mcpCall(mcpToken, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_api_list", arguments: { projectId: "proj_nope" } },
    });
    expect(status).toBe(200);
    const text = (data as { result: { content: { text: string }[] } }).result.content[0].text;
    expect(text).toContain("项目不存在");
  });
});

describe("Admin API", () => {
  it("无 admin token → 401", async () => {
    const res = await fetch(`${baseUrl}/admin/api/projects`);
    expect(res.status).toBe(401);
  });

  it("添加项目 → 工具热更新可见", async () => {
    const res = await fetch(`${baseUrl}/admin/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": adminToken },
      body: JSON.stringify({ name: "Demo", desc: "d", url: "http://127.0.0.1:9/none.json" }),
    });
    expect(res.status).toBe(201);
    const proj = (await res.json()) as { id: string };
    expect(proj.id).toMatch(/^proj_/);

    // list_projects 应反映新项目
    const { data } = await mcpCall(mcpToken, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "list_projects", arguments: {} },
    });
    const list = JSON.parse((data as { result: { content: { text: string }[] } }).result.content[0].text);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Demo");
  });

  it("删除项目后 list_projects 为空", async () => {
    const listRes = await fetch(`${baseUrl}/admin/api/projects`, {
      headers: { "X-Admin-Token": adminToken },
    });
    const projects = (await listRes.json()) as { id: string }[];
    const id = projects[0].id;

    const delRes = await fetch(`${baseUrl}/admin/api/projects/${id}`, {
      method: "DELETE",
      headers: { "X-Admin-Token": adminToken },
    });
    expect(delRes.status).toBe(200);

    const { data } = await mcpCall(mcpToken, {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "list_projects", arguments: {} },
    });
    const list = JSON.parse((data as { result: { content: { text: string }[] } }).result.content[0].text);
    expect(list).toEqual([]);
  });

  it("reset-token 生成新 token，旧 token 失效", async () => {
    const res = await fetch(`${baseUrl}/admin/api/security/reset-token`, {
      method: "POST",
      headers: { "X-Admin-Token": adminToken },
    });
    const body = (await res.json()) as { newToken: string };
    expect(body.newToken).not.toBe(mcpToken);
    expect(body.newToken).toMatch(/^mcp_key_/);

    // 旧 token 应失效
    const old = await mcpCall(mcpToken, { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
    expect(old.status).toBe(401);
    // 新 token 可用
    const nw = await mcpCall(body.newToken, { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    expect(nw.status).toBe(200);
  });
});
