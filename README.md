# 🔌 API MCP Manager

> 可视化 API 知识库 MCP 客户端 — 为 AI Agent（Cursor / Claude Desktop 等）提供统一的多项目 Swagger/OpenAPI 检索网关。

基于 MCP（Model Context Protocol）协议的 **Streamable HTTP** 传输，支持懒加载缓存、局部 `$ref` 解引用、双向鉴权加固。

## ✨ 核心特性

- **Streamable HTTP 传输**：采用 MCP 官方新标准（单端点 `POST /mcp`），不依赖已废弃的 SSE 双端点
- **三个只读工具**：`list_projects` / `get_api_list` / `get_api_details`，严格只读边界
- **懒加载二级缓存**：首次调用拉取 Swagger，TTL 2h + 自动 GC，避免启动卡顿与内存暴涨
- **局部 `$ref` 解引用**：仅展开目标接口节点的 schema，控制 token 成本
- **双向鉴权加固**：
  - MCP 客户端：静态 API Key（Bearer Header / X-MCP-Token / Query 降级）+ OAuth 2.1 预留骨架
  - 管理后台：动态 Session Token，仅回环地址允许 query 下发，CORS 运行时自适应
- **安全存储**：配置文件 `0600` 权限，上游 token 可选 AES-256-GCM 加密
- **多形态交付**：Electron 桌面端（Win/Mac）+ Linux CLI（Node SEA 单二进制）

## 🏗️ 架构

```
api-mcp-manage/
├─ packages/
│  ├─ core/        # MCP 核心引擎（server / tools / swagger / config / auth）
│  ├─ web/         # React + Vite + Tailwind 管理后台
│  └─ desktop/     # Electron 壳（托盘常驻 / 开机自启）
└─ apps/
   └─ cli/         # Linux 无界面入口（SEA 打包目标）
```

## 🚀 快速开始

### 环境要求
- Node.js ≥ 20
- pnpm ≥ 9

### 安装与运行

```bash
# 安装依赖
pnpm install

# 构建 core + web
pnpm build

# 启动 CLI 服务（Linux / 本地运行）
pnpm start
```

启动后控制台输出：

```
🚀 API MCP Manager Server (V1.3) 已启动！
─────────────────────────────────────────────────────
📡 MCP Endpoint (Streamable HTTP):  http://localhost:3001/mcp
🛠️  Web Dashboard:                   http://localhost:3001/admin?token=Session_xxx
🔑 MCP Client Token:                 mcp_key_xxx
─────────────────────────────────────────────────────
```

### 开发模式

```bash
# 终端 1：启动 core server（watch）
pnpm --filter @api-mcp/core dev

# 终端 2：启动 web 开发服务器（热更新，代理到 core）
pnpm --filter @api-mcp/web dev
```

## 🔗 客户端接入

在 Cursor 或 Claude Desktop 的 MCP 配置中添加：

**Cursor（Header 鉴权，推荐）**
```json
"mcpServers": {
  "api-mcp-manager": {
    "url": "http://localhost:3001/mcp",
    "headers": { "Authorization": "Bearer mcp_key_xxx" }
  }
}
```

**Claude Desktop（Query 传参，需注意日志泄露）**
```json
"mcpServers": {
  "api-mcp-manager": {
    "url": "http://localhost:3001/mcp?token=mcp_key_xxx"
  }
}
```

Token 可在 Web 后台的「安全」面板查看与重置。

## 🛠️ MCP 工具

| 工具 | 入参 | 返回 | 说明 |
|------|------|------|------|
| `list_projects` | — | JSON | 所有 API 项目列表 |
| `get_api_list` | `projectId`, `keyword?` | Markdown | 接口路由概要（首次触发懒加载） |
| `get_api_details` | `projectId`, `path`, `method` | Markdown | 接口详情（局部 `$ref` 解引用） |

## 🔐 安全设计

| 防护层 | 机制 |
|--------|------|
| MCP 端点鉴权 | 静态 API Key（三传参方式）+ 拦截未授权访问 |
| 管理后台鉴权 | 一次性 Session Token，非回环拒绝 query 下发 |
| 配置存储 | 文件 `0600`，上游 token AES-256-GCM 加密 |
| 日志脱敏 | URL 中的 token 自动脱敏为 `***` |
| 公网部署 | 启动时检测非回环绑定并强警告需 TLS |

## 🧪 测试

```bash
# 单元 + 集成测试（73 项）
pnpm --filter @api-mcp/core test

# 类型检查
pnpm -r run typecheck
```

## 📦 打包

### 完整流程（一次性产出全部形态）

```bash
pnpm install                            # 安装依赖
pnpm build                              # core + web + cli（不含 desktop）
pnpm --filter @api-mcp/cli build:sea    # Linux/无界面单二进制
pnpm --filter @api-mcp/desktop build    # desktop 主进程打包（esbuild → CJS）
pnpm --filter @api-mcp/desktop dist     # Electron 安装包（DMG / NSIS）
```

### 逐项说明

| 目标 | 命令 | 产物 | 说明 |
|------|------|------|------|
| Core 引擎 | `pnpm --filter @api-mcp/core build` | `packages/core/dist/` | TypeScript 编译 |
| Web 管理后台 | `pnpm --filter @api-mcp/web build` | `packages/web/dist/` | Vite 构建，运行时由 core 托管 |
| 一键构建（core+web+cli） | `pnpm build` | — | 等价于 `pnpm -r --filter=!@api-mcp/desktop run build`，日常本地运行用此 + `pnpm start` |
| **Linux 单二进制** | `pnpm --filter @api-mcp/cli build:sea` | `apps/cli/sea-out/api-mcp-<platform>-<arch>`（约 174M） | Node SEA，脚本内置验证（启动 + MCP 响应） |
| **Electron 桌面端** | `pnpm --filter @api-mcp/desktop build && pnpm --filter @api-mcp/desktop dist` | `packages/desktop/release/API MCP Manager-1.3.0.dmg`（约 102M）/ `.exe` | macOS DMG / Windows NSIS |

> ⚠️ **Electron 两步构建**：desktop 的 `build`（esbuild 把主进程 + `@api-mcp/core` 打成单一 CJS，规避 ESM/CJS 互操作）与 `dist`（electron-builder）是两个独立步骤，**不能跳过 `build` 直接 `dist`**，否则 asar 内缺少入口文件。

### SEA 单二进制运行

```bash
# 产物路径含平台与架构后缀，如 darwin-x64 / linux-x64
./apps/cli/sea-out/api-mcp-darwin-x64

# 可选：把 web 构建产物放到二进制同目录，启用管理后台 UI
mkdir -p apps/cli/sea-out/assets/web
cp -r packages/web/dist/* apps/cli/sea-out/assets/web/
```

**SEA 部署形态**：把生成的二进制 + `assets/web/`（可选）放到目标机器即可，无需 Node.js 运行时。

### 辅助命令

| 命令 | 用途 |
|------|------|
| `pnpm test` | 全部测试（73 项） |
| `pnpm -r run typecheck` | 4 包类型检查 |
| `pnpm start` | 本地运行 CLI 服务（tsx 直接跑源码） |
| `pnpm --filter @api-mcp/web dev` | Web 开发热更新（代理到 core:3001） |
| `pnpm --filter @api-mcp/core dev` | Core watch 模式 |
| `pnpm --filter @api-mcp/desktop pack` | Electron 仅打目录包（不生成安装包，调试用） |

## 🧪 验证状态

| 验证项 | 状态 |
|--------|------|
| 单元 + 集成测试（config / auth / format / $ref 解引用 / 归一化 / 缓存 / 服务器） | ✅ 73/73 通过 |
| MCP 协议端到端（initialize / tools/list / tools/call） | ✅ 通过 |
| $ref 解引用（真实 Petstore API，含 Swagger 2.x body 参数） | ✅ 通过 |
| 生产集成（web 托管 + CRUD + MCP 热更新） | ✅ 通过 |
| Node SEA 单二进制（独立运行 + MCP 响应） | ✅ 通过 |
| Electron 桌面端（DMG 打包 + 启动 MCP server + tools/list） | ✅ 通过 |

## 📋 配置文件

存储路径：
- macOS/Windows (Electron)：`app.getPath('userData')/mcp-projects.json`
- Linux (CLI)：`~/.config/api-mcp-manager/mcp-projects.json`（或 `$XDG_CONFIG_HOME`）

## 📄 许可证

MIT
