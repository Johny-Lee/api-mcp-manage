/**
 * Electron 主进程 — 启动 core server + 加载 web 后台 + 系统托盘
 */
import { app, BrowserWindow, Tray, Menu, shell, nativeImage } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { startServer, stopServer } from "@api-mcp/core";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverInfo: { port: number; adminSessionToken: string } | null = null;
let isQuitting = false;

/** 启动内嵌 MCP server */
async function bootServer() {
  try {
    serverInfo = await startServer({
      port: 3001,
      configPath: join(app.getPath("userData"), "mcp-projects.json"),
      webDistPath: resolveWebDist(),
    });
    console.log(`[Desktop] MCP server started on port ${serverInfo.port}`);
  } catch (err) {
    console.error("[Desktop] Failed to start server:", err);
  }
}

/** 查找 web 构建产物 */
function resolveWebDist(): string {
  const candidates = [
    // 开发
    join(__dirname, "..", "..", "..", "web", "dist"),
    // 打包后（asar 内）
    join(process.resourcesPath || "", "web-dist"),
    // 同目录
    join(__dirname, "..", "public"),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "index.html"))) return p;
  }
  return join(process.cwd(), "public");
}

/** 创建主窗口 */
function createWindow() {
  if (!serverInfo) {
    // server 未就绪时延迟创建
    setTimeout(createWindow, 500);
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: "API MCP Manager",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 加载内嵌 server 的 admin 页面（同源，自带 token）
  mainWindow.loadURL(`http://localhost:${serverInfo.port}/admin?token=${serverInfo.adminSessionToken}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // 关闭窗口 → 最小化到托盘（不退出）
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow?.hide();
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

/** 创建系统托盘 */
function createTray() {
  tray = new Tray(createTrayIcon());
  const contextMenu = Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => mainWindow?.show() },
    { label: "隐藏到托盘", click: () => mainWindow?.hide() },
    { type: "separator" },
    {
      label: serverInfo ? `MCP 端口: ${serverInfo.port}` : "MCP 服务未运行",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: async () => {
        isQuitting = true;
        await stopServer();
        tray?.destroy();
        app.quit();
      },
    },
  ]);

  tray.setToolTip("API MCP Manager");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => mainWindow?.show());
}

/** 创建托盘图标（占位 16x16 透明 PNG） */
function createTrayIcon() {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR4nO3OQQ0AIBADwYJ/obBgjPbJKq3gESxgYyCgYyCgYyCgYyCgYyCgYyCgYyCgYyCgYyCgYyCgYyCgYyAAAABJruz0wAAAABJRU5ErkJggg==",
    "base64",
  );
  return nativeImage.createFromBuffer(png, { scaleFactor: 1.0 });
}

// ──────────────────────────────────────────────
// App 生命周期
// ──────────────────────────────────────────────
app.whenReady().then(async () => {
  await bootServer();
  createWindow();
  createTray();
});

// macOS 点击 dock 图标时重新显示窗口
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

// 防止应用在所有窗口关闭时退出（托盘常驻）
app.on("window-all-closed", () => {
  // 不调用 app.quit()，保持托盘常驻
});

// 应用退出前关闭 server
app.on("before-quit", async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    isQuitting = true;
    await stopServer();
    app.quit();
  }
});
