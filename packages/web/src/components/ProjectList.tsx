import { useState, useEffect, useCallback } from "react";
import { api, type ProjectItem, type TestResult, type ApiSource, type ProjectInput, type ApiItem } from "../api";

export default function ProjectList() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [viewingProject, setViewingProject] = useState<ProjectItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getProjects();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await api.testConnection(id);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "测试失败" });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除该项目？")) return;
    try {
      await api.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    }
  };

  if (loading) {
    return <div className="text-center py-12 text-gray-500">加载中...</div>;
  }

  // 项目详情视图：接口列表
  if (viewingProject) {
    return (
      <ProjectDetail
        project={viewingProject}
        onBack={() => setViewingProject(null)}
      />
    );
  }

  return (
    <div>
      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={load} className="ml-3 underline">重试</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-700">
          API 项目 ({projects.length})
        </h2>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
        >
          + 添加项目
        </button>
      </div>

      {/* Add Form */}
      {showAdd && (
        <ProjectForm
          onClose={() => setShowAdd(false)}
          onSaved={(p) => {
            setProjects((prev) => [...prev, p]);
            setShowAdd(false);
          }}
        />
      )}

      {/* Edit Form */}
      {editingId && (
        <ProjectForm
          initial={projects.find((p) => p.id === editingId)}
          onClose={() => setEditingId(null)}
          onSaved={(updated) => {
            setProjects((prev) =>
              prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)),
            );
            setEditingId(null);
          }}
        />
      )}

      {/* Empty State */}
      {projects.length === 0 && !showAdd && (
        <div className="text-center py-12 bg-white rounded-lg border border-dashed border-gray-300">
          <p className="text-gray-400 text-lg mb-2">📭 暂无 API 项目</p>
          <p className="text-gray-400 text-sm">点击「添加项目」接入第一个 Swagger/OpenAPI 文档</p>
        </div>
      )}

      {/* Project Cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onView={() => setViewingProject(p)}
            onEdit={() => setEditingId(p.id)}
            onDelete={() => handleDelete(p.id)}
            onTest={() => handleTest(p.id)}
            testing={testingId === p.id}
          />
        ))}
      </div>

      {/* Test Result Modal */}
      {testResult && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setTestResult(null)}>
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-2xl ${testResult.ok ? "" : "text-red-500"}`}>
                {testResult.ok ? "✅" : "❌"}
              </span>
              <h3 className="text-lg font-semibold">
                {testResult.ok ? "连接成功" : "连接失败"}
              </h3>
            </div>
            {testResult.ok ? (
              <div className="text-sm text-gray-600 space-y-1">
                <p><span className="font-medium">文档标题:</span> {testResult.title}</p>
                <p><span className="font-medium">接口数量:</span> {testResult.pathCount}</p>
                {testResult.version && <p><span className="font-medium">版本:</span> {testResult.version}</p>}
              </div>
            ) : (
              <p className="text-sm text-red-600">{testResult.error}</p>
            )}
            <button
              onClick={() => setTestResult(null)}
              className="mt-4 px-4 py-2 bg-gray-200 rounded-md text-sm hover:bg-gray-300 w-full"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 项目卡片 */
function ProjectCard({
  project,
  onView,
  onEdit,
  onDelete,
  onTest,
  testing,
}: {
  project: ProjectItem;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  testing: boolean;
}) {
  const isYapi = project.source === "yapi";
  const endpointDisplay = isYapi
    ? `${project.baseUrl || ""} · pid=${project.projectId || ""}`
    : project.url || "";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-2">
        <button onClick={onView} className="text-left flex-1 min-w-0 hover:text-blue-600 transition-colors">
          <h3 className="font-semibold text-gray-800 truncate">{project.name}</h3>
          <p className="text-xs text-gray-400 font-mono mt-0.5">{project.id}</p>
        </button>
        <div className="flex items-center gap-1">
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isYapi ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}
            title={isYapi ? "YApi 导出源" : "Swagger/OpenAPI 源"}
          >
            {isYapi ? "YApi" : "Swagger"}
          </span>
          {project.hasToken && (
            <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded" title="已配置 Token">
              🔑
            </span>
          )}
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-2 line-clamp-2 cursor-pointer hover:text-gray-700" onClick={onView}>
        {project.desc || "无描述"}
      </p>
      <p className="text-xs text-gray-400 truncate mb-3" title={endpointDisplay}>
        📡 {endpointDisplay || "—"}
      </p>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={onView}
          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
        >
          📋 查看接口
        </button>
        <button
          onClick={onTest}
          disabled={testing}
          className="px-3 py-1.5 text-xs bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100 disabled:opacity-50 transition-colors"
        >
          {testing ? "测试中..." : "🔍 测试连接"}
        </button>
        <button
          onClick={onEdit}
          className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
        >
          ✏️ 编辑
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-1.5 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100 transition-colors"
        >
          🗑️ 删除
        </button>
      </div>
    </div>
  );
}

/** 项目详情视图：展示该项目的接口列表 */
function ProjectDetail({
  project,
  onBack,
}: {
  project: ProjectItem;
  onBack: () => void;
}) {
  const [apis, setApis] = useState<ApiItem[]>([]);
  const [title, setTitle] = useState(project.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");

  const load = useCallback(async (kw?: string) => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getProjectApis(project.id, kw);
      setApis(data.apis);
      setTitle(data.title || project.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [project.id, project.name]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSearch = () => load(keyword.trim() || undefined);

  const methodColor = (method: string): string => {
    const map: Record<string, string> = {
      GET: "bg-green-100 text-green-700",
      POST: "bg-blue-100 text-blue-700",
      PUT: "bg-orange-100 text-orange-700",
      DELETE: "bg-red-100 text-red-700",
      PATCH: "bg-purple-100 text-purple-700",
    };
    return map[method] || "bg-gray-100 text-gray-700";
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
          >
            ← 返回
          </button>
          <div>
            <h2 className="text-lg font-semibold text-gray-700">{title}</h2>
            <p className="text-xs text-gray-400">{project.id}</p>
          </div>
        </div>
        <span className="text-sm text-gray-500">接口数: {loading ? "..." : apis.length}</span>
      </div>

      {/* Search */}
      <div className="flex gap-2 mb-4">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          placeholder="按路径或接口名搜索..."
        />
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
        >
          搜索
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => load()} className="ml-3 underline">重试</button>
        </div>
      )}

      {/* Loading */}
      {loading && <div className="text-center py-12 text-gray-500">加载接口列表中...</div>}

      {/* Empty */}
      {!loading && !error && apis.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-dashed border-gray-300">
          <p className="text-gray-400">📭 该项目暂无接口</p>
        </div>
      )}

      {/* API List */}
      {!loading && !error && apis.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {apis.map((api, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
              <span className={`text-xs font-mono font-bold px-2 py-1 rounded min-w-[60px] text-center ${methodColor(api.method)}`}>
                {api.method}
              </span>
              <code className="text-sm text-gray-800 flex-1 truncate font-mono" title={api.path}>
                {api.path}
              </code>
              <span className="text-sm text-gray-500 truncate max-w-[40%]" title={api.summary}>
                {api.summary || "—"}
                {api.deprecated && <span className="ml-1 text-orange-500">⚠️废弃</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 添加/编辑表单 */
function ProjectForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: ProjectItem;
  onClose: () => void;
  onSaved: (p: ProjectItem) => void;
}) {
  const isEdit = !!initial;
  const [source, setSource] = useState<ApiSource>(initial?.source || "swagger");
  const [name, setName] = useState(initial?.name || "");
  const [desc, setDesc] = useState(initial?.desc || "");
  const [url, setUrl] = useState(initial?.url || "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || "");
  const [projectId, setProjectId] = useState(initial?.projectId || "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isYapi = source === "yapi";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("名称为必填项");
      return;
    }
    if (isYapi) {
      if (!baseUrl.trim() || !projectId.trim()) {
        setError("YApi 实例地址与项目 ID 为必填项");
        return;
      }
    } else {
      if (!url.trim()) {
        setError("Swagger/OpenAPI URL 为必填项");
        return;
      }
    }
    setSaving(true);
    setError("");
    try {
      if (isEdit) {
        const patch: Partial<ProjectInput> = { source, name, desc };
        if (isYapi) { patch.baseUrl = baseUrl; patch.projectId = projectId; }
        else { patch.url = url; }
        if (token) patch.token = token;
        await api.updateProject(initial!.id, patch);
        onSaved({
          ...initial!,
          source, name, desc,
          ...(isYapi ? { baseUrl, projectId } : { url }),
          hasToken: !!token || initial!.hasToken,
          updatedAt: new Date().toISOString(),
        } as ProjectItem);
      } else {
        const p = await api.addProject({
          source, name, desc,
          ...(isYapi ? { baseUrl, projectId } : { url }),
          token: token || undefined,
        });
        onSaved(p);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <form
        className="bg-white rounded-lg p-6 max-w-lg w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="text-lg font-semibold mb-4">{isEdit ? "编辑项目" : "添加项目"}</h3>

        {error && <div className="mb-3 p-2 bg-red-50 text-red-600 text-sm rounded">{error}</div>}

        <div className="space-y-3">
          {/* Source selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">文档来源</label>
            <div className="flex gap-2">
              {(["swagger", "yapi"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSource(s)}
                  className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                    source === s
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  {s === "swagger" ? "Swagger / OpenAPI" : "YApi"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">名称 *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              placeholder="如：用户中心微服务"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">描述</label>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              placeholder="简要描述该项目提供的接口能力"
            />
          </div>

          {/* Conditional fields by source */}
          {isYapi ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">YApi 实例地址 *</label>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                  placeholder="https://yapi.example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">项目 ID *</label>
                <input
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                  placeholder="YApi 项目设置中的 project id"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Swagger/OpenAPI URL *</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                placeholder="http://api.internal.com/v2/api-docs"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {isYapi ? "项目 Token" : "上游 Token"} {isEdit ? "(留空保持不变)" : "(可选)"}
            </label>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
              placeholder={isYapi ? "YApi 项目设置 → token" : "bearer xxx 或纯 token"}
              type="password"
            />
            {isYapi && (
              <p className="mt-1 text-xs text-gray-400">
                YApi 的项目 token（项目设置页可见），用于访问 swagger 导出端点，加密存储。
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            type="submit"
            disabled={saving}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "保存中..." : isEdit ? "更新" : "添加"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded-md hover:bg-gray-300 transition-colors"
          >
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
