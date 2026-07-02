/**
 * Node SEA 打包脚本
 *
 * 流程：
 * 1. esbuild 将 CLI 入口 + 所有依赖（含 @api-mcp/core）打包成单文件 CJS
 * 2. 生成 SEA blob（Node 20+ 原生 postject 之前）
 * 3. 复制 node 二进制并注入 blob → 单一可执行文件
 *
 * 用法: node scripts/build-sea.mjs
 */
import { build } from "esbuild";
import { copyFile, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { platform, arch } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = apps/cli/scripts
const OUT_DIR = join(__dirname, "..", "sea-out");

const entryFile = join(__dirname, "..", "src", "sea-entry.ts");

async function main() {
  console.log("🏗️  开始 Node SEA 打包...");
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  // 1. esbuild bundle → 单文件 CJS
  console.log("1️⃣  esbuild 打包中...");
  const bundleFile = join(OUT_DIR, "bundle.cjs");
  await build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: bundleFile,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    logLevel: "info",
  });
  console.log("   ✅ bundle.cjs 生成完成");

  // 2. 生成 SEA config
  console.log("2️⃣  生成 SEA blob...");
  const seaConfigPath = join(OUT_DIR, "sea-config.json");
  const seaConfig = {
    main: bundleFile,
    output: join(OUT_DIR, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
  };
  await writeFile(seaConfigPath, JSON.stringify(seaConfig, null, 2));

  // 生成 blob
  execSync(`node --experimental-sea-config "${seaConfigPath}"`, { stdio: "inherit" });
  console.log("   ✅ sea-prep.blob 生成完成");

  // 3. 复制 node 二进制
  console.log("3️⃣  复制 Node 二进制...");
  const nodeBin = process.execPath;
  const ext = platform() === "win32" ? ".exe" : "";
  const seaBinName = `api-mcp-${platform()}-${arch()}${ext}`;
  const seaBinPath = join(OUT_DIR, seaBinName);
  await copyFile(nodeBin, seaBinPath);
  console.log(`   ✅ 复制到 ${seaBinPath}`);

  // macOS: 移除签名（注入前需去签名）
  if (platform() === "darwin") {
    try {
      execSync(`codesign --remove-signature "${seaBinPath}"`, { stdio: "inherit" });
      console.log("   ✅ 已移除 macOS 代码签名");
    } catch {
      console.log("   ⚠️  移除签名失败（可能无签名），继续");
    }
  }

  // 处理旧版 Node（如 20.x）二进制中 SEA fuse 多次出现导致 postject 报错的问题：
  // 把除第一处外的 fuse 字符串破坏掉，确保 postject 只识别到一个注入点。
  const fuseStr = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
  const seaBuf = await readFile(seaBinPath);
  const fuseBuf = Buffer.from(fuseStr);
  let searchFrom = 0;
  let fuseIdx = seaBuf.indexOf(fuseBuf, searchFrom);
  let deduped = 0;
  while (fuseIdx !== -1) {
    const next = seaBuf.indexOf(fuseBuf, fuseIdx + fuseBuf.length);
    if (next !== -1) {
      // 破坏第二处及之后的 fuse（改首字母），仅保留第一处
      seaBuf.write("X", next, "ascii");
      deduped++;
      searchFrom = next + fuseBuf.length;
    } else {
      break;
    }
  }
  if (deduped > 0) {
    await writeFile(seaBinPath, seaBuf);
    console.log(`   ✅ 已去重 ${deduped} 处冗余 SEA fuse`);
  }

  // 4. postject 注入 blob（用编程式 API，更可控）
  console.log("4️⃣  注入 SEA blob...");
  const { inject } = await import("postject");
  const blobData = await readFile(join(OUT_DIR, "sea-prep.blob"));
  const machoSegmentName = platform() === "darwin" ? "NODE_SEA" : undefined;
  await inject(seaBinPath, "NODE_SEA_BLOB", blobData, {
    sentinelFuse: fuseStr,
    machoSegmentName,
  });
  console.log("   ✅ blob 注入完成");

  // macOS: 重新签名（ad-hoc）
  if (platform() === "darwin") {
    try {
      execSync(`codesign --sign - "${seaBinPath}"`, { stdio: "inherit" });
      console.log("   ✅ 已重新签名（ad-hoc）");
    } catch {
      console.log("   ⚠️  重新签名失败，二进制仍可用但需手动授权");
    }
  }

  // 5. 设置可执行权限
  if (platform() !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(seaBinPath, 0o755);
  }

  // 6. 验证：启动 SEA 二进制，探测端口，确认 server 真正起来
  console.log("\n5️⃣  验证 SEA 二进制...");
  const { spawn } = await import("node:child_process");
  const verifyPort = 13928; // 避开常用端口
  const child = spawn(seaBinPath, [], {
    env: { ...process.env, MCP_PORT: String(verifyPort), MCP_SKIP_WEB: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let verified = false;
  const verifyTimeout = setTimeout(() => {
    if (!verified) {
      console.log("   ⚠️  验证超时（端口未就绪）");
      child.kill("SIGTERM");
    }
  }, 10000);
  child.stdout.on("data", (d) => {
    const out = d.toString();
    if (out.includes("已启动") || out.includes("MCP Endpoint")) {
      verified = true;
      clearTimeout(verifyTimeout);
      console.log("   ✅ SEA 二进制成功启动 MCP server");
      // 真实请求验证
      setTimeout(async () => {
        try {
          const banner = out.match(/mcp_key_[a-f0-9]+/);
          const token = banner ? banner[0] : "";
          const r = await fetch(`http://localhost:${verifyPort}/admin/api/info`, {
            headers: { "X-Admin-Token": "sea" },
          });
          // 401 也是正常（鉴权生效）
          if (r.status === 401 || r.status === 200) {
            console.log("   ✅ HTTP 端点响应正常");
          }
          const mcpR = await fetch(`http://localhost:${verifyPort}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json, text/event-stream",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          });
          if (mcpR.status === 200) {
            console.log("   ✅ MCP tools/list 通过 SEA 二进制响应");
          }
        } catch (e) {
          console.log("   ⚠️  请求验证失败:", e.message);
        }
        child.kill("SIGTERM");
      }, 1000);
    }
  });
  child.stderr.on("data", (d) => {
    const err = d.toString();
    if (err.includes("Error") || err.includes("error")) {
      console.log("   ⚠️  SEA stderr:", err.slice(0, 200));
    }
  });
  await new Promise((resolve) => {
    child.on("exit", () => resolve());
    verifyTimeout;
  });

  console.log(`\n🎉 SEA 打包完成！`);
  console.log(`📦 产物: ${seaBinPath}`);
  const { statSync } = await import("node:fs");
  const sizeMb = (statSync(seaBinPath).size / 1024 / 1024).toFixed(1);
  console.log(`📏 大小: ${sizeMb} MB`);
}

main().catch((err) => {
  console.error("❌ SEA 打包失败:", err);
  process.exit(1);
});
