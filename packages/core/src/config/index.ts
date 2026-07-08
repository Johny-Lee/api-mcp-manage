import { readFile, writeFile, mkdir, chmod, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { McpProject, McpProjectsConfig } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * 配置管理器 - 负责 mcp-projects.json 的持久化与安全读写
 *
 * 安全特性：
 * - 文件权限 0600（仅所有者可读写）
 * - 上游 token 字段可选 AES-256-GCM 加密存储
 * - 加密密钥来自环境变量 MCP_CONFIG_KEY 或机器绑定派生
 */

const CONFIG_FILENAME = "mcp-projects.json";
const SCHEMA_VERSION = 1;
const ENCRYPTED_PREFIX = "enc::";

/** 解析配置文件存储路径 */
export function getConfigPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  const os = platform();
  if (os === "win32" || os === "darwin") {
    // Electron 使用 app.getPath('userData') 时由调用方传入 overridePath
    // CLI / 回退场景使用用户目录
    return join(homedir(), ".api-mcp-manager", CONFIG_FILENAME);
  }
  // Linux
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return join(xdgConfig, "api-mcp-manager", CONFIG_FILENAME);
  return join(homedir(), ".config", "api-mcp-manager", CONFIG_FILENAME);
}

/** 生成新项目 ID */
export function generateProjectId(): string {
  return "proj_" + randomBytes(4).toString("hex");
}

/** 生成静态 API Key */
export function generateApiKey(): string {
  return "mcp_key_" + randomBytes(16).toString("hex");
}

/** 生成 Admin Session Token（每次启动一次性） */
export function generateAdminSessionToken(): string {
  return "Session_" + randomBytes(12).toString("hex");
}

/** 派生加密密钥（AES-256 需要 32 字节） */
function deriveKey(): Buffer {
  const envKey = process.env.MCP_CONFIG_KEY;
  const source = envKey || `${homedir()}:${platform()}`;
  return scryptSync(source, "api-mcp-manager-salt", 32);
}

/** AES-256-GCM 加密字符串 */
function encryptString(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 格式: enc::base64(iv).base64(tag).base64(data)
  return `${ENCRYPTED_PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

/** AES-256-GCM 解密字符串 */
function decryptString(encrypted: string): string {
  if (!encrypted.startsWith(ENCRYPTED_PREFIX)) {
    // 明文（兼容旧配置或无密钥场景）
    return encrypted;
  }
  const key = deriveKey();
  const payload = encrypted.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("加密 token 格式损坏");
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const data = Buffer.from(parts[2], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/** 是否启用加密 */
function encryptionEnabled(): boolean {
  return process.env.MCP_CONFIG_DISABLE_ENCRYPT !== "1";
}

/** 安全写入文件（0600 权限） */
async function safeWriteFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // 先写临时再原子替换（简化版：直接写 + chmod）
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch((err) => {
    logger.warn(`无法设置文件权限 0600: ${path}`, { error: String(err) });
  });
}

/** 默认配置 */
function defaultConfig(): McpProjectsConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      mcp_client_token: generateApiKey(),
      admin_port: 3001,
    },
    projects: [],
  };
}

/** 序列化配置（加密敏感字段） */
function serializeConfig(config: McpProjectsConfig): string {
  const clone: McpProjectsConfig = JSON.parse(JSON.stringify(config));
  if (encryptionEnabled()) {
    for (const proj of clone.projects) {
      if (proj.token && !proj.token.startsWith(ENCRYPTED_PREFIX)) {
        proj.token = encryptString(proj.token);
      }
    }
  }
  return JSON.stringify(clone, null, 2);
}

/** 反序列化配置（解密敏感字段 + 旧配置迁移 source 默认值） */
function deserializeConfig(raw: string): McpProjectsConfig {
  const parsed = JSON.parse(raw) as McpProjectsConfig;
  if (!parsed.settings || !Array.isArray(parsed.projects)) {
    throw new Error("配置文件结构无效：缺少 settings 或 projects");
  }
  // 迁移：旧项目无 source 字段，默认 swagger
  for (const proj of parsed.projects) {
    if (!proj.source) proj.source = "swagger";
    // 解密 token
    if (proj.token && proj.token.startsWith(ENCRYPTED_PREFIX)) {
      try {
        proj.token = decryptString(proj.token);
      } catch (err) {
        logger.error(`解密项目 ${proj.id} 的 token 失败`, { error: String(err) });
        proj.token = undefined;
      }
    }
  }
  return parsed;
}

/** 加载配置（不存在则创建默认并持久化） */
export async function loadConfig(overridePath?: string): Promise<McpProjectsConfig> {
  const path = getConfigPath(overridePath);
  try {
    await access(path, constants.R_OK);
    const raw = await readFile(path, "utf8");
    const config = deserializeConfig(raw);
    logger.debug("配置已加载", { path, projectCount: config.projects.length });
    return config;
  } catch {
    // 文件不存在或读取失败 → 创建默认配置
    logger.info("配置文件不存在，创建默认配置", { path });
    const config = defaultConfig();
    await saveConfig(config, overridePath);
    return config;
  }
}

/** 保存配置（加密 + 0600 权限） */
export async function saveConfig(config: McpProjectsConfig, overridePath?: string): Promise<void> {
  const path = getConfigPath(overridePath);
  const serialized = serializeConfig(config);
  await safeWriteFile(path, serialized);
  logger.debug("配置已保存", { path, projectCount: config.projects.length });
}

/** 新增项目输入（兼容 swagger 直填 url 与 yapi 基地址+projectId） */
export interface AddProjectInput {
  name: string;
  desc: string;
  /** 文档来源类型，默认 swagger */
  source?: import("../types.js").ApiSource;
  /** swagger 源：文档地址 */
  url?: string;
  /** yapi 源：实例基地址 */
  baseUrl?: string;
  /** yapi 源：项目 ID */
  projectId?: string;
  /** 上游 / yapi 项目 token */
  token?: string;
  /** 是否导入 JSON 模式（true 时无需 url/baseUrl/projectId/token，不自动拉取/刷新） */
  importMode?: boolean;
}

/** 添加项目 */
export async function addProject(
  config: McpProjectsConfig,
  input: AddProjectInput,
  overridePath?: string,
): Promise<{ config: McpProjectsConfig; project: McpProject }> {
  validateProjectInput(input);
  const now = new Date().toISOString();
  const project: McpProject = {
    id: generateProjectId(),
    name: input.name,
    desc: input.desc,
    source: input.source || "swagger",
    url: input.url,
    baseUrl: input.baseUrl,
    projectId: input.projectId,
    token: input.token,
    importMode: input.importMode || false,
    createdAt: now,
    updatedAt: now,
  };
  config.projects.push(project);
  await saveConfig(config, overridePath);
  return { config, project };
}

/** 更新项目（支持 source/url/baseUrl/projectId/token/name/desc/importMode） */
export async function updateProject(
  config: McpProjectsConfig,
  id: string,
  patch: Partial<AddProjectInput>,
  overridePath?: string,
): Promise<McpProjectsConfig> {
  const proj = config.projects.find((p) => p.id === id);
  if (!proj) throw new Error(`项目不存在: ${id}`);
  // 从导入模式切回自动拉取：清除导入文档
  if (proj.importMode && patch.importMode === false) {
    proj.importedDoc = undefined;
  }
  Object.assign(proj, patch, { updatedAt: new Date().toISOString() });
  // 切换 source 时校验新形态字段
  validateProjectInput(proj);
  await saveConfig(config, overridePath);
  return config;
}

/** 校验项目输入：导入模式跳过连接字段；否则按 source 检查必填字段 */
function validateProjectInput(input: AddProjectInput): void {
  if (!input.name) throw new Error("项目 name 必填");
  const source = input.source || "swagger";
  // postman 源仅支持导入 JSON 模式（无标准 HTTP 文档端点）
  if (source === "postman") {
    if (!input.importMode) throw new Error("postman 源仅支持导入 JSON 模式");
    return;
  }
  // 导入 JSON 模式：无需上游连接字段
  if (input.importMode) return;
  if (source === "swagger") {
    if (!input.url) throw new Error("swagger 源需要 url 字段");
  } else if (source === "yapi") {
    if (!input.baseUrl) throw new Error("yapi 源需要 baseUrl 字段");
    if (!input.projectId) throw new Error("yapi 源需要 projectId 字段");
  } else if (source === "apifox") {
    // apifox 自动拉取：projectId + token 必填（baseUrl 可选，缺省用公有云默认值）
    if (!input.projectId) throw new Error("apifox 源需要 projectId 字段");
    if (!input.token) throw new Error("apifox 源需要 token（访问令牌）");
  }
}

/** 删除项目 */
export async function removeProject(
  config: McpProjectsConfig,
  id: string,
  overridePath?: string,
): Promise<McpProjectsConfig> {
  config.projects = config.projects.filter((p) => p.id !== id);
  await saveConfig(config, overridePath);
  return config;
}

/**
 * 持久化导入的文档到指定项目（导入 JSON 模式专用）
 *
 * 校验 project.importMode 为 true 后写入 importedDoc 并保存。
 * @returns 更新后的 config
 */
export async function setImportedDoc(
  config: McpProjectsConfig,
  id: string,
  doc: import("../types.js").OpenApiDocument,
  overridePath?: string,
): Promise<McpProjectsConfig> {
  const proj = config.projects.find((p) => p.id === id);
  if (!proj) throw new Error(`项目不存在: ${id}`);
  if (!proj.importMode) {
    throw new Error(`项目 ${id} 非导入 JSON 模式，不支持导入`);
  }
  proj.importedDoc = doc;
  proj.updatedAt = new Date().toISOString();
  await saveConfig(config, overridePath);
  return config;
}

/** 重置 MCP 客户端 Token */
export async function resetMcpToken(
  config: McpProjectsConfig,
  overridePath?: string,
): Promise<{ config: McpProjectsConfig; newToken: string }> {
  const newToken = generateApiKey();
  config.settings.mcp_client_token = newToken;
  await saveConfig(config, overridePath);
  return { config, newToken };
}

/** 缓存设置更新入参 */
export interface CacheSettingsPatch {
  /** 缓存 TTL（毫秒），>0 生效 */
  cache_ttl_ms?: number;
  /** 缓存类型 */
  cache_type?: "memory" | "redis";
  /** Redis 连接配置（cache_type=redis 时必填） */
  cache_redis?: import("../types.js").CacheRedisConfig;
}

/**
 * 更新缓存设置并持久化
 *
 * 校验规则：
 * - cache_type=redis 时 cache_redis.url 必填
 * - cache_ttl_ms 若提供必须 >0
 */
export async function updateCacheSettings(
  config: McpProjectsConfig,
  patch: CacheSettingsPatch,
  overridePath?: string,
): Promise<McpProjectsConfig> {
  if (patch.cache_type) {
    if (patch.cache_type === "redis") {
      if (!patch.cache_redis?.url) {
        throw new Error("cache_type=redis 时必须配置 cache_redis.url");
      }
    }
    config.settings.cache_type = patch.cache_type;
  }
  if (patch.cache_redis !== undefined) {
    // 显式传 null 清除，否则赋值
    config.settings.cache_redis = patch.cache_redis || undefined;
  }
  if (patch.cache_ttl_ms !== undefined) {
    if (patch.cache_ttl_ms <= 0) {
      throw new Error("cache_ttl_ms 必须 >0");
    }
    config.settings.cache_ttl_ms = patch.cache_ttl_ms;
  }
  await saveConfig(config, overridePath);
  return config;
}

/**
 * 更新 Web 后台访问 Token 持久化设置
 *
 * - 开启持久化（persist=true）：优先复用当前进程内存中的 token（currentToken），
 *   其次复用已存 admin_session_token，都没有则生成新的，保存后返回
 * - 关闭持久化（persist=false）：清除已存的 admin_session_token，返回 null
 *
 * @param currentToken 当前进程内存中的 adminSessionToken（若有，开启持久化时优先沿用，保证当前会话重启后仍有效）
 * @returns { config, adminSessionToken } 开启时返回持久化 token，关闭时返回 null
 */
export async function updateAdminTokenPersistence(
  config: McpProjectsConfig,
  persist: boolean,
  overridePath?: string,
  currentToken?: string,
): Promise<{ config: McpProjectsConfig; adminSessionToken: string | null }> {
  config.settings.persist_admin_token = persist;
  if (persist) {
    // 优先沿用当前内存 token -> 已存 token -> 新生成
    const token = currentToken || config.settings.admin_session_token || generateAdminSessionToken();
    config.settings.admin_session_token = token;
    await saveConfig(config, overridePath);
    return { config, adminSessionToken: token };
  }
  // 关闭持久化：清除已存 token
  config.settings.admin_session_token = undefined;
  await saveConfig(config, overridePath);
  return { config, adminSessionToken: null };
}
