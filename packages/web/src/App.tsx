import { useState, useEffect } from "react";
import { initAuth, api, type SecurityInfo } from "./api";
import ProjectList from "./components/ProjectList";
import SettingPanel from "./components/SettingPanel";

type Tab = "projects" | "security";

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("projects");
  const [security, setSecurity] = useState<SecurityInfo | null>(null);
  const [showMcpHelp, setShowMcpHelp] = useState(false);

  useEffect(() => {
    setAuthed(initAuth());
  }, []);

  useEffect(() => {
    if (!authed) return;
    api.getSecurity().then(setSecurity).catch(() => {});
  }, [authed]);

  const handleResetToken = async () => {
    const { newToken } = await api.resetToken();
    setSecurity((prev) => (prev ? { ...prev, mcpClientToken: newToken } : null));
  };

  const handlePersistAdminTokenChanged = (persist: boolean) => {
    setSecurity((prev) => (prev ? { ...prev, persistAdminToken: persist } : null));
  };

  if (!authed) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-lg text-center max-w-md">
          <img src="/api-logo.png" alt="API MCP Manager" className="w-16 h-16 mx-auto mb-4 rounded-lg" />
          <h1 className="text-2xl font-bold mb-4">API MCP Manager</h1>
          <p className="text-red-600 mb-4">
            ⚠️ 未检测到有效的 Admin Session Token
          </p>
          <p className="text-gray-600 text-sm">
            请通过服务器启动时输出的 URL 访问管理后台（含 <code className="bg-gray-200 px-1 rounded">?token=</code> 参数）。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/api-logo.png" alt="API MCP Manager" className="w-8 h-8 rounded-md" />
            <h1 className="text-xl font-bold text-gray-800">API MCP Manager</h1>
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-mono">V1.3</span>
          </div>
          <div className="flex items-center gap-3">
            {/* 连接状态 */}
            {security && (
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span>服务运行中 · 端口 {security.port}</span>
              </div>
            )}
            <nav className="flex items-center gap-1">
              <TabButton active={tab === "projects"} onClick={() => setTab("projects")}>
                📦 项目
              </TabButton>
              <button
                onClick={() => setShowMcpHelp(true)}
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                title="MCP 接入方式"
              >
                ❓
              </button>
              <TabButton active={tab === "security"} onClick={() => setTab("security")}>
                ⚙️ 设置
              </TabButton>
            </nav>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {tab === "projects" ? <ProjectList /> : <SettingPanel info={security} onReset={handleResetToken} onPersistAdminTokenChanged={handlePersistAdminTokenChanged} />}
      </main>

      {/* MCP 接入方式弹层 */}
      {showMcpHelp && security && (
        <McpHelpModal info={security} onClose={() => setShowMcpHelp(false)} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
        active
          ? "bg-blue-600 text-white shadow-sm"
          : "text-gray-600 hover:bg-gray-100"
      }`}
    >
      {children}
    </button>
  );
}

/** MCP 接入方式弹层 */
function McpHelpModal({ info, onClose }: { info: SecurityInfo; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const cursorConfig = JSON.stringify(
    {
      mcpServers: {
        "api-mcp-manager": {
          url: `http://localhost:${info.port}/mcp`,
          headers: { Authorization: `Bearer ${info.mcpClientToken}` },
        },
      },
    },
    null,
    2,
  );

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        "api-mcp-manager": {
          url: `http://localhost:${info.port}/mcp?token=${info.mcpClientToken}`,
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 shadow-xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">MCP 接入方式</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Cursor */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-blue-700">🖥️ Cursor（Header 鉴权，推荐）</label>
            <button
              onClick={() => copyText(cursorConfig, "cursor")}
              className="px-2 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition-colors"
            >
              {copied === "cursor" ? "✅ 已复制" : "📋 复制"}
            </button>
          </div>
          <pre className="bg-gray-900 text-green-400 p-3 rounded-md text-xs overflow-x-auto max-h-48">
            {cursorConfig}
          </pre>
        </div>

        {/* Claude Desktop */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-orange-700">
              🤖 Claude Desktop（Query 传参，⚠️ Token 可能泄露至日志）
            </label>
            <button
              onClick={() => copyText(claudeConfig, "claude")}
              className="px-2 py-1 text-xs bg-orange-50 text-orange-600 rounded hover:bg-orange-100 transition-colors"
            >
              {copied === "claude" ? "✅ 已复制" : "📋 复制"}
            </button>
          </div>
          <pre className="bg-gray-900 text-green-400 p-3 rounded-md text-xs overflow-x-auto max-h-48">
            {claudeConfig}
          </pre>
        </div>

        <p className="mt-3 text-xs text-gray-400">
          ⚠️ Claude Desktop 的 EventSource 不支持自定义 Header，因此使用 Query 传参。Token 可能出现在浏览器历史/服务器日志中。如部署到公网，请务必启用 TLS。
        </p>

        <button
          onClick={onClose}
          className="mt-4 px-4 py-2 bg-gray-200 rounded-md text-sm hover:bg-gray-300 w-full"
        >
          关闭
        </button>
      </div>
    </div>
  );
}
