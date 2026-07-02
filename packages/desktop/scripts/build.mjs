/**
 * Electron 主进程打包脚本
 *
 * 用 esbuild 将 src/main/index.ts 及其依赖（含 ESM 的 @api-mcp/core）
 * 打包成单一 CJS 文件，规避 Electron 主进程无法 require() ESM 的问题。
 *
 * electron 自身由运行时提供，标记为 external。
 *
 * 注意：本脚本不构建 web 后台。web 构建产物由 electron-builder 的
 * extraResources 配置在 dist 阶段从 ../web/dist 复制到 Resources/web-dist。
 * 打包前请确保已执行 pnpm --filter @api-mcp/web build。
 */
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // 前置检查：web 构建产物必须存在（否则打包出的应用无管理后台）
  const webDist = join(__dirname, "..", "..", "web", "dist", "index.html");
  if (!existsSync(webDist)) {
    console.error("❌ web 构建产物不存在：" + webDist);
    console.error("   请先执行: pnpm --filter @api-mcp/web build");
    process.exit(1);
  }
  console.log("✅ 检测到 web 构建产物存在");

  const outDir = join(__dirname, "..", "dist", "main");
  await rm(join(__dirname, "..", "dist"), { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [join(__dirname, "..", "src", "main", "index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: join(outDir, "index.js"),
    minify: false,
    sourcemap: true,
    legalComments: "none",
    // electron 由 Electron 运行时注入，不打进 bundle
    external: ["electron"],
    logLevel: "info",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });

  console.log("✅ desktop main 打包完成 (CJS): dist/main/index.js");
}

main().catch((err) => {
  console.error("❌ desktop 打包失败:", err);
  process.exit(1);
});
