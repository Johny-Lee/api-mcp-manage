#!/usr/bin/env node
/**
 * API MCP Manager — CLI 入口（Linux / 无界面运行）
 *
 * 使用方式:
 *   tsx src/index.ts
 *   node dist/index.js
 *   ./api-mcp-linux  (SEA 打包产物)
 */
import { startServer } from "@api-mcp/core";

async function main() {
  process.on("SIGINT", async () => {
    const { stopServer } = await import("@api-mcp/core");
    await stopServer();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    const { stopServer } = await import("@api-mcp/core");
    await stopServer();
    process.exit(0);
  });

  try {
    await startServer({
      port: parseInt(process.env.MCP_PORT || "3001", 10),
      configPath: process.env.MCP_CONFIG_PATH,
      skipWeb: process.env.MCP_SKIP_WEB === "1",
    });
  } catch (err) {
    console.error("❌ 启动失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
