/**
 * SEA (Single Executable Application) 入口
 *
 * 此文件由 esbuild 全量 bundle 成单文件 CJS，再注入 Node 二进制。
 * 注意：SEA 环境下 node_modules 不可用，所有依赖必须静态打包。
 *
 * 与普通 CLI 入口的差异：
 * - 配置/资源路径以 SEA 二进制所在目录为基准
 * - web 静态资源外置于同目录 assets/web（SEA 无法内置多文件资源）
 */
import { startServer, stopServer } from "@api-mcp/core";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

// SEA 下 process.execPath 指向二进制自身；其所在目录即部署目录
const binDir = dirname(process.execPath);
const webDist = join(binDir, "assets", "web");
const configPath = process.env.MCP_CONFIG_PATH || join(binDir, "config", "mcp-projects.json");

async function main() {
  process.on("SIGINT", async () => {
    await stopServer();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await stopServer();
    process.exit(0);
  });

  try {
    await startServer({
      port: parseInt(process.env.MCP_PORT || "3001", 10),
      configPath,
      webDistPath: existsSync(join(webDist, "index.html")) ? webDist : undefined,
      skipWeb: !existsSync(join(webDist, "index.html")),
    });
  } catch (err) {
    console.error("❌ 启动失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
