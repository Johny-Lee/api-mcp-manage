import { useState, useEffect } from "react";
import { initAuth } from "./api";
import ProjectList from "./components/ProjectList";
import SecurityPanel from "./components/SecurityPanel";

type Tab = "projects" | "security";

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("projects");

  useEffect(() => {
    setAuthed(initAuth());
  }, []);

  if (!authed) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-lg text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4">🔌 API MCP Manager</h1>
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
            <span className="text-2xl">🔌</span>
            <h1 className="text-xl font-bold text-gray-800">API MCP Manager</h1>
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-mono">V1.3</span>
          </div>
          <nav className="flex gap-1">
            <TabButton active={tab === "projects"} onClick={() => setTab("projects")}>
              📦 项目
            </TabButton>
            <TabButton active={tab === "security"} onClick={() => setTab("security")}>
              🔐 安全
            </TabButton>
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {tab === "projects" ? <ProjectList /> : <SecurityPanel />}
      </main>
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
