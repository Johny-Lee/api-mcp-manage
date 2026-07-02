import { useState, useEffect, useCallback } from "react";
import { api, type SecurityInfo } from "../api";

export default function SecurityPanel() {
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getSecurity();
      setInfo(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleReset = async () => {
    if (!confirm("重置后将使旧 Token 立即失效，所有已连接的客户端需要更新配置。确定继续？")) return;
    setResetting(true);
    try {
      const { newToken } = await api.resetToken();
      setInfo((prev) => prev ? { ...prev, mcpClientToken: newToken } : null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "重置失败");
    } finally {
      setResetting(false);
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  if (loading) {
    return <div className="text-center py-12 text-gray-500">加载中...</div>;
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
        {error}
        <button onClick={load} className="ml-3 underline">重试</button>
      </div>
    );
  }

  if (!info) return null;

  const cursorConfig = JSON.stringify(
    {
      mcpServers: {
        "api-mcp-manager": {
          url: `http://localhost:${info.port}/mcp`,
          headers: {
            Authorization: `Bearer ${info.mcpClientToken}`,
          },
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
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-700">🔐 安全配置</h2>

      {/* Token Display */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-gray-700">MCP 客户端访问密钥</h3>
          <button
            onClick={handleReset}
            disabled={resetting}
            className="px-3 py-1.5 text-xs bg-orange-50 text-orange-600 rounded hover:bg-orange-100 disabled:opacity-50 transition-colors"
          >
            {resetting ? "重置中..." : "🔄 重置 Token"}
          </button>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-md p-3 font-mono text-sm text-gray-700 break-all flex items-center justify-between group">
          <span>{info.mcpClientToken}</span>
          <button
            onClick={() => copyText(info.mcpClientToken, "token")}
            className="ml-2 px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300 transition-colors shrink-0"
          >
            {copied === "token" ? "✅ 已复制" : "📋 复制"}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          MCP 端点: <code className="bg-gray-100 px-1 rounded">{info.mcpEndpoint}</code> · 端口: {info.port}
        </p>
      </div>

      {/* Config Copy Area */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-medium text-gray-700 mb-3">📋 一键接入配置</h3>

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
      </div>

      {/* Connection Status */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-medium text-gray-700 mb-3">📶 连接状态</h3>
        <div className="flex items-center gap-2">
          <span className="inline-block w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse" />
          <span className="text-sm text-gray-600">服务运行中 · 端口 {info.port}</span>
        </div>
      </div>
    </div>
  );
}
