/**
 * 配置管理器测试 — 加密、读写、CRUD、权限
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  addProject,
  updateProject,
  removeProject,
  resetMcpToken,
  generateApiKey,
  generateProjectId,
} from "./index.js";
import type { McpProjectsConfig } from "../types.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  configPath = join(tmpDir, "mcp-projects.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("config 加载与默认值", () => {
  it("文件不存在时创建默认配置", async () => {
    const config = await loadConfig(configPath);
    expect(config.schemaVersion).toBe(1);
    expect(config.projects).toEqual([]);
    expect(config.settings.mcp_client_token).toMatch(/^mcp_key_/);
    expect(config.settings.admin_port).toBe(3001);
  });

  it("已存在文件正确加载", async () => {
    const config = await loadConfig(configPath);
    config.settings.admin_port = 4000;
    await saveConfig(config, configPath);

    const reloaded = await loadConfig(configPath);
    expect(reloaded.settings.admin_port).toBe(4000);
  });
});

describe("配置文件安全", () => {
  it("文件权限为 0600", async () => {
    await loadConfig(configPath);
    const stat = statSync(configPath);
    // POSIX 权限掩码
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("token 字段加密存储（启用加密）", async () => {
    const config = await loadConfig(configPath);
    await addProject(config, {
      name: "Test",
      desc: "desc",
      url: "http://example.com",
      token: "bearer my-secret-token",
    }, configPath);

    // 读取原始文件内容，验证 token 不是明文
    const raw = readFileSync(configPath, "utf8");
    expect(raw).not.toContain("my-secret-token");
    expect(raw).toContain("enc::");
  });

  it("重新加载后 token 正确解密", async () => {
    const config = await loadConfig(configPath);
    await addProject(config, {
      name: "Test",
      desc: "desc",
      url: "http://example.com",
      token: "bearer my-secret-token",
    }, configPath);

    const reloaded = await loadConfig(configPath);
    expect(reloaded.projects[0].token).toBe("bearer my-secret-token");
  });
});

describe("项目 CRUD", () => {
  let config: McpProjectsConfig;

  beforeEach(async () => {
    config = await loadConfig(configPath);
  });

  it("添加项目", async () => {
    const { config: c, project } = await addProject(config, {
      name: "用户中心",
      desc: "用户服务",
      url: "http://api.example.com/docs",
    }, configPath);
    expect(project.id).toMatch(/^proj_/);
    expect(c.projects).toHaveLength(1);
    expect(c.projects[0].name).toBe("用户中心");
  });

  it("更新项目", async () => {
    const { config: c, project } = await addProject(config, {
      name: "原名",
      desc: "描述",
      url: "http://example.com",
    }, configPath);
    const updated = await updateProject(c, project.id, { name: "新名" }, configPath);
    expect(updated.projects[0].name).toBe("新名");
  });

  it("删除项目", async () => {
    const { config: c, project } = await addProject(config, {
      name: "删除我",
      desc: "",
      url: "http://example.com",
    }, configPath);
    expect(c.projects).toHaveLength(1);
    const after = await removeProject(c, project.id, configPath);
    expect(after.projects).toHaveLength(0);
  });

  it("更新不存在项目抛错", async () => {
    await expect(updateProject(config, "proj_nonexistent", { name: "x" }, configPath)).rejects.toThrow();
  });
});

describe("Token 重置", () => {
  it("resetMcpToken 生成新 token", async () => {
    const config = await loadConfig(configPath);
    const oldToken = config.settings.mcp_client_token;
    const { config: c, newToken } = await resetMcpToken(config, configPath);
    expect(newToken).not.toBe(oldToken);
    expect(c.settings.mcp_client_token).toBe(newToken);
    expect(newToken).toMatch(/^mcp_key_/);
  });
});

describe("ID 生成器", () => {
  it("generateApiKey 格式正确", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^mcp_key_[a-f0-9]{32}$/);
  });

  it("generateProjectId 格式正确", () => {
    const id = generateProjectId();
    expect(id).toMatch(/^proj_[a-f0-9]{8}$/);
  });

  it("每次生成唯一", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).not.toBe(b);
  });
});
