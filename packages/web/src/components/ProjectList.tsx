import { useState, useEffect, useCallback } from "react";
import { api, type ProjectItem, type ApiSource, type ProjectInput, type ApiItem } from "../api";
import ApiDetailModal from "./ApiDetailModal";
import ImportJsonModal from "./ImportJsonModal";

export default function ProjectList() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // 自动选中第一个项目（首次加载或删除后回退）
  useEffect(() => {
    if (!selectedId && projects.length > 0) {
      setSelectedId(projects[0].id);
    }
  }, [projects, selectedId]);

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除该项目？")) return;
    try {
      await api.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setSelectedId((prev) => (prev === id ? null : prev));
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    }
  };

  if (loading) {
    return <div className="text-center py-12 text-gray-500">加载中...</div>;
  }

  const selectedProject = projects.find((p) => p.id === selectedId) || null;

  return (
    <div className="flex gap-4 h-[calc(100vh-140px)]">
      {/* 左侧：项目列表 */}
      <aside className="w-72 flex-shrink-0 flex flex-col min-h-0 bg-white rounded-lg border border-gray-200 overflow-hidden">
        {/* 头部 + 新增按钮 */}
        <div className="p-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
          <h2 className="text-sm font-semibold text-gray-700">
            项目 ({projects.length})
          </h2>
          <button
            onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 transition-colors"
          >
            + 新增项目
          </button>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="m-3 p-2 bg-red-50 border border-red-200 rounded-md text-red-700 text-xs flex-shrink-0">
            {error}
            <button onClick={load} className="ml-2 underline">重试</button>
          </div>
        )}

        {/* 项目列表（可滚动） */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {projects.length === 0 && !error ? (
            <div className="text-center py-10 px-4">
              <p className="text-gray-400 text-sm mb-1">📭 暂无项目</p>
              <p className="text-gray-400 text-xs">点击「新增项目」开始接入</p>
            </div>
          ) : (
            projects.map((p) => {
              const isYapi = p.source === "yapi";
              const isApifox = p.source === "apifox";
              const isPostman = p.source === "postman";
              const isImport = !!p.importMode;
              const isSelected = selectedId === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={`group flex items-start gap-2 px-3 py-2.5 border-l-2 cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-blue-50 border-blue-500"
                      : "border-transparent hover:bg-gray-50"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          isPostman ? "bg-amber-500" : isApifox ? "bg-orange-500" : isImport ? "bg-emerald-500" : isYapi ? "bg-purple-500" : "bg-blue-500"
                        }`}
                      />
                      <h3
                        className={`text-sm font-medium truncate ${
                          isSelected ? "text-blue-700" : "text-gray-800"
                        }`}
                      >
                        {p.name}
                      </h3>
                    </div>
                    <p className="text-xs text-gray-400 truncate mt-0.5 ml-3">
                      {isPostman
                        ? `Postman · 导入${p.hasImportedDoc ? "" : " · 未导入"}`
                        : isApifox
                          ? isImport
                            ? `Apifox · 导入${p.hasImportedDoc ? "" : " · 未导入"}`
                            : `Apifox · pid=${p.projectId || ""}`
                          : isImport
                            ? `导入 JSON${p.hasImportedDoc ? "" : " · 未导入"}`
                            : isYapi
                              ? `YApi · pid=${p.projectId || ""}`
                              : p.url || "Swagger"}
                    </p>
                  </div>
                  {/* 编辑 / 删除 */}
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(p.id);
                      }}
                      className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      title="编辑"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(p.id);
                      }}
                      className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      title="删除"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* 右侧：选中项目的接口列表 */}
      <main className="flex-1 min-w-0 min-h-0">
        {selectedProject ? (
          <ProjectDetail
            key={selectedProject.id}
            project={selectedProject}
          />
        ) : (
          <div className="h-full flex items-center justify-center bg-white rounded-lg border border-dashed border-gray-300">
            <div className="text-center">
              <p className="text-gray-400 text-lg mb-2">👈 请选择一个项目</p>
              <p className="text-gray-400 text-sm">在左侧选择项目以查看接口列表</p>
            </div>
          </div>
        )}
      </main>

      {/* 新增表单 */}
      {showAdd && (
        <ProjectForm
          onClose={() => setShowAdd(false)}
          onSaved={(p) => {
            setProjects((prev) => [...prev, p]);
            setShowAdd(false);
            setSelectedId(p.id);
          }}
        />
      )}

      {/* 编辑表单 */}
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
    </div>
  );
}

/** 项目详情视图：展示该项目的接口列表 */
function ProjectDetail({
  project,
}: {
  project: ProjectItem;
}) {
  const [apis, setApis] = useState<ApiItem[]>([]);
  const [title, setTitle] = useState(project.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [detailApi, setDetailApi] = useState<ApiItem | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const [showImport, setShowImport] = useState(false);

  const isImport = !!project.importMode;

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

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg("");
    try {
      const result = await api.refreshProject(project.id);
      if (result.ok) {
        setRefreshMsg(`已刷新：${result.pathCount} 个接口`);
        // 刷新成功后重新加载接口列表
        await load(keyword.trim() || undefined);
      } else {
        setRefreshMsg(`刷新失败：${result.error || "未知错误"}`);
      }
    } catch (err) {
      setRefreshMsg(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setRefreshing(false);
      // 3 秒后清除提示
      setTimeout(() => setRefreshMsg(""), 3000);
    }
  };

  // 导入 JSON 成功后：重新加载接口列表并提示
  const handleImported = async (pathCount: number) => {
    setShowImport(false);
    setRefreshMsg(`已导入：${pathCount} 个接口`);
    await load(keyword.trim() || undefined);
    setTimeout(() => setRefreshMsg(""), 3000);
  };

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

  const isYapi = project.source === "yapi";
  const isApifox = project.source === "apifox";
  const isPostman = project.source === "postman";

  return (
    <div className="flex flex-col h-full min-h-0 bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* 头部：标题 + 搜索 */}
      <div className="p-4 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-700 truncate">{title}</h2>
              <span
                className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${
                  isPostman ? "bg-amber-100 text-amber-700" : isApifox ? "bg-orange-100 text-orange-700" : isYapi ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
                }`}
              >
                {isPostman ? "Postman" : isApifox ? "Apifox" : isYapi ? "YApi" : "Swagger"}
              </span>
              {isImport && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 flex-shrink-0">
                  导入 JSON
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">{project.id}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-sm text-gray-500">接口数: {loading ? "..." : apis.length}</span>
            {isImport ? (
              <button
                onClick={() => setShowImport(true)}
                className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-xs rounded-md hover:bg-emerald-100 transition-colors"
                title="粘贴 JSON 导入接口文档"
              >
                📥 导入 JSON
              </button>
            ) : (
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="px-2.5 py-1 bg-gray-100 text-gray-600 text-xs rounded-md hover:bg-gray-200 disabled:opacity-50 transition-colors"
                title="从上游重新拉取并刷新缓存"
              >
                {refreshing ? "刷新中..." : "🔄 刷新缓存"}
              </button>
            )}
            {refreshMsg && (
              <span className={`text-xs ${refreshMsg.startsWith("已") ? "text-green-600" : "text-red-500"}`}>
                {refreshMsg}
              </span>
            )}
          </div>
        </div>

        {/* 搜索 */}
        <div className="flex gap-2">
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
      </div>

      {/* 接口列表（可滚动） */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* 错误 */}
        {error && (
          <div className="m-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
            {error}
            <button onClick={() => load()} className="ml-3 underline">重试</button>
          </div>
        )}

        {/* 加载中 */}
        {loading && <div className="text-center py-12 text-gray-500">加载接口列表中...</div>}

        {/* 空状态 */}
        {!loading && !error && apis.length === 0 && (
          <div className="text-center py-12">
            {isImport && !project.hasImportedDoc ? (
              <>
                <p className="text-gray-400 mb-2">📭 尚未导入接口文档</p>
                <p className="text-gray-400 text-sm mb-4">点击右上角「导入 JSON」按钮，粘贴 JSON 后识别导入</p>
                <button
                  onClick={() => setShowImport(true)}
                  className="px-4 py-2 bg-emerald-600 text-white text-sm rounded-md hover:bg-emerald-700 transition-colors"
                >
                  📥 导入 JSON
                </button>
              </>
            ) : (
              <p className="text-gray-400">📭 该项目暂无接口</p>
            )}
          </div>
        )}

        {/* 接口列表 */}
        {!loading && !error && apis.length > 0 && (
          <div className="divide-y divide-gray-100">
            {apis.map((api, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors cursor-pointer"
                onClick={() => setDetailApi(api)}
              >
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

      {/* 接口详情弹层 */}
      {detailApi && (
        <ApiDetailModal
          projectId={project.id}
          api={detailApi}
          onClose={() => setDetailApi(null)}
        />
      )}

      {/* 导入 JSON 弹层 */}
      {showImport && (
        <ImportJsonModal
          projectId={project.id}
          source={project.source}
          projectName={project.name}
          onClose={() => setShowImport(false)}
          onImported={handleImported}
        />
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
  const [source, setSource] = useState<ApiSource>(initial?.source || "yapi");
  const [importMode, setImportMode] = useState<boolean>(!!initial?.importMode);
  const [name, setName] = useState(initial?.name || "");
  const [desc, setDesc] = useState(initial?.desc || "");
  const [url, setUrl] = useState(initial?.url || "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || "");
  const [projectId, setProjectId] = useState(initial?.projectId || "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isYapi = source === "yapi";
  const isApifox = source === "apifox";
  const isPostman = source === "postman";
  // yapi 与 apifox 均使用 baseUrl + projectId 配置形态（baseUrl 对 apifox 可选）
  const usesProjectConfig = isYapi || isApifox;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("名称为必填项");
      return;
    }
    // 导入 JSON 模式：无需上游连接字段，仅校验名称
    if (!importMode) {
      if (usesProjectConfig) {
        if (isApifox) {
          // apifox：projectId 必填，baseUrl 可选
          if (!projectId.trim()) {
            setError("Apifox 项目 ID 为必填项");
            return;
          }
        } else {
          // yapi：baseUrl + projectId 均必填
          if (!baseUrl.trim() || !projectId.trim()) {
            setError("YApi 实例地址与项目 ID 为必填项");
            return;
          }
        }
      } else {
        if (!url.trim()) {
          setError("Swagger/OpenAPI URL 为必填项");
          return;
        }
      }
    }
    setSaving(true);
    setError("");
    try {
      // 自动拉取模式的连接字段（按 source 形态组装）
      const connFields = !importMode
        ? usesProjectConfig
          ? { baseUrl: isApifox ? (baseUrl || undefined) : baseUrl, projectId }
          : { url }
        : {};
      if (isEdit) {
        const patch: Partial<ProjectInput> = { source, name, desc, importMode };
        if (!importMode) Object.assign(patch, connFields);
        if (!importMode && token) patch.token = token;
        await api.updateProject(initial!.id, patch);
        onSaved({
          ...initial!,
          source, name, desc, importMode,
          ...connFields,
          hasToken: !importMode ? (!!token || initial!.hasToken) : false,
          // 切换为自动拉取时后端会清除 importedDoc；切换为导入模式时保留已导入状态
          hasImportedDoc: importMode ? initial!.hasImportedDoc : false,
          updatedAt: new Date().toISOString(),
        } as ProjectItem);
      } else {
        const p = await api.addProject({
          source, name, desc, importMode,
          ...connFields,
          token: !importMode ? (token || undefined) : undefined,
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
          {/* Source selector（自动拉取与导入 JSON 均需选择项目类型，决定校验格式） */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">项目类型</label>
            <div className="flex gap-2 flex-wrap">
              {(["yapi", "swagger", "apifox", "postman"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setSource(s);
                    // postman 源仅支持导入 JSON 模式，选择时自动切换
                    if (s === "postman") setImportMode(true);
                  }}
                  className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                    source === s
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  {s === "swagger" ? "Swagger / OpenAPI" : s === "yapi" ? "YApi" : s === "apifox" ? "Apifox" : "Postman"}
                </button>
              ))}
            </div>
            {importMode && (
              <p className="mt-1 text-xs text-gray-400">
                {isPostman
                  ? "导入时按 Postman Collection v2.1/v2.0 格式校验（仅支持导入 JSON）"
                  : isApifox
                    ? "导入时按 Apifox 数据导出格式校验（含 apiCollection 字段）"
                    : isYapi
                      ? "导入时按 YApi 原生接口详情数组格式校验"
                      : "导入时按 OpenAPI / Swagger 文档格式校验"}
              </p>
            )}
          </div>

          {/* 添加方式：自动拉取 / 导入 JSON（postman 源强制导入模式，禁用切换） */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">添加方式</label>
            <div className="flex gap-4">
              <label className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border transition-colors ${isPostman ? "bg-gray-100 text-gray-300 border-gray-200 cursor-not-allowed" : !importMode ? "bg-blue-600 text-white border-blue-600 cursor-pointer" : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50 cursor-pointer"}`}>
                <input
                  type="radio"
                  name="importMode"
                  checked={!importMode}
                  onChange={() => setImportMode(false)}
                  disabled={isPostman}
                  className="hidden"
                />
                🔗 自动拉取
              </label>
              <label className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border transition-colors ${importMode ? "bg-emerald-600 text-white border-emerald-600 cursor-pointer" : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50 cursor-pointer"}`}>
                <input
                  type="radio"
                  name="importMode"
                  checked={importMode}
                  onChange={() => setImportMode(true)}
                  className="hidden"
                />
                📥 导入 JSON
              </label>
            </div>
            {isPostman && (
              <p className="mt-1 text-xs text-orange-500">Postman 仅支持导入 JSON 模式</p>
            )}
            {isApifox && (
              <p className="mt-1 text-xs text-gray-400">
                {importMode ? "导入时按 Apifox 数据导出格式校验（含 apiCollection 字段）" : "通过 Apifox 开放 API 自动拉取 OpenAPI 文档"}
              </p>
            )}
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

          {/* 导入 JSON 模式：无需上游连接字段，仅提示创建后在接口列表导入 */}
          {importMode ? (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-md text-emerald-700 text-xs">
              创建项目后，在接口列表点击「导入 JSON」按钮粘贴 JSON 文本即可导入接口文档。
            </div>
          ) : (
            <>
              {/* Conditional fields by source */}
              {usesProjectConfig ? (
                <>
                  {isApifox && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Apifox API 地址 <span className="text-gray-400 font-normal">(可选)</span>
                      </label>
                      <input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                        placeholder="https://api.apifox.com（默认，私有化部署可改）"
                      />
                    </div>
                  )}
                  {!isApifox && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">YApi 实例地址 *</label>
                      <input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                        placeholder="https://yapi.example.com"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">项目 ID *</label>
                    <input
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                      placeholder={isApifox ? "Apifox 项目 ID（项目设置中查看）" : "YApi 项目设置中的 project id"}
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
                  {isApifox ? "访问令牌 *" : isYapi ? "项目 Token" : "上游 Token"} {isEdit ? "(留空保持不变)" : isApifox ? "" : "(可选)"}
                </label>
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                  placeholder={isApifox ? "Apifox 访问令牌（API 访问令牌）" : isYapi ? "YApi 项目设置 → token" : "bearer xxx 或纯 token"}
                  type="password"
                />
                {isYapi && (
                  <p className="mt-1 text-xs text-gray-400">
                    YApi 的项目 token（项目设置页可见），用于访问 swagger 导出端点，加密存储。
                  </p>
                )}
                {isApifox && (
                  <p className="mt-1 text-xs text-gray-400">
                    Apifox 的 API 访问令牌（账户设置 → API 访问令牌），用于调用开放 API，加密存储。
                  </p>
                )}
              </div>
            </>
          )}
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
