import { useState, useRef } from "react";
import { api, type ApiSource } from "../api";

/**
 * 导入 JSON 弹层
 *
 * 用于「导入 JSON」模式项目：粘贴 JSON 文本或选择本地 JSON 文件，点击「识别并导入」
 * 由后端按项目 source 类型校验对应格式后导入（swagger→OpenAPI/Swagger 文档，
 * yapi→YApi 原生接口详情数组）。
 *
 * 校验与转换在后端完成（parseImportedDoc），前端仅负责展示结果与错误。
 */
export default function ImportJsonModal({
  projectId,
  source,
  projectName,
  onClose,
  onImported,
}: {
  projectId: string;
  source: ApiSource;
  projectName: string;
  onClose: () => void;
  /** 导入成功后回调（参数为接口数） */
  onImported: (pathCount: number) => void;
}) {
  const [json, setJson] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [fileName, setFileName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isYapi = source === "yapi";
  const isApifox = source === "apifox";
  const isPostman = source === "postman";

  // 选择本地 JSON 文件并读取到 textarea
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setSuccess("");
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setJson(text);
      setFileName(file.name);
    };
    reader.onerror = () => {
      setError("读取文件失败");
    };
    reader.readAsText(file);
    // 清空 input value 以便重复选择同一文件
    e.target.value = "";
  };

  const handleImport = async () => {
    if (!json.trim()) {
      setError("请粘贴 JSON 内容或选择 JSON 文件");
      return;
    }
    setImporting(true);
    setError("");
    setSuccess("");
    try {
      const result = await api.importProjectDoc(projectId, json);
      if (result.ok) {
        setSuccess(`导入成功：${result.pathCount ?? 0} 个接口`);
        // 稍作停留展示成功提示，再回调关闭
        setTimeout(() => onImported(result.pathCount ?? 0), 600);
      } else {
        setError(result.error || "导入失败：未知错误");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 shrink-0">
          <span className="text-base font-semibold text-gray-700">导入 JSON</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{projectName}</span>
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isPostman ? "bg-amber-100 text-amber-700" : isApifox ? "bg-orange-100 text-orange-700" : isYapi ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}
          >
            {isPostman ? "Postman" : isApifox ? "Apifox" : isYapi ? "YApi" : "Swagger"}
          </span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2 ml-auto"
            title="关闭"
          >
            ×
          </button>
        </div>

        {/* 格式提示 */}
        <div className="px-5 py-2 border-b border-gray-100 bg-gray-50 shrink-0">
          <p className="text-xs text-gray-500">
            {isPostman ? (
              <>请粘贴 <b>Postman Collection 导出 JSON</b>（Postman「Export {">"} Collection v2.1」格式，含 <code>item</code> 数组的对象）</>
            ) : isApifox ? (
              <>请粘贴 <b>Apifox 数据导出 JSON</b>（Apifox「项目设置 {">"} 数据导出 {">"} Apifox」格式，含 <code>apiCollection</code> 字段的对象）</>
            ) : isYapi ? (
              <>请粘贴 <b>YApi 接口详情数组</b>或<b>数据导出格式</b>（含分组的 <code>list</code>）。前者为 <code>[{`{_id, path, method, ...}`}]</code>；后者为 <code>[{`{name, list: [...]}`}]</code>，分组 <code>name</code> 会作为菜单名展示</>
            ) : (
              <>请粘贴 <b>OpenAPI / Swagger 文档</b>（含 <code>openapi</code> 或 <code>swagger</code> 与 <code>paths</code> 字段的 JSON 对象）</>
            )}
            ，点击「识别并导入」按对应格式校验后导入。
          </p>
        </div>

        {/* 错误 / 成功提示 */}
        {(error || success) && (
          <div
            className={`mx-5 mt-3 p-2 rounded text-sm shrink-0 ${
              error ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"
            }`}
          >
            {error || success}
          </div>
        )}

        {/* Body — 工具条 + textarea */}
        <div className="flex-1 min-h-0 px-5 py-3 flex flex-col">
          {/* 工具条：选择文件 */}
          <div className="flex items-center gap-2 mb-2 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json,text/plain"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs rounded-md hover:bg-gray-200 transition-colors"
              title="选择本地 JSON 文件"
            >
              📄 选择文件
            </button>
            {fileName && (
              <span className="text-xs text-gray-500 truncate" title={fileName}>
                {fileName}
              </span>
            )}
          </div>

          <textarea
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              setFileName("");
            }}
            className="flex-1 min-h-0 w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            placeholder={isPostman ? '{\n  "info": { "name": "Collection", "schema": "https://schema.getpostman.com/.../v2.1.0/..." },\n  "item": [\n    { "name": "登录", "request": { "method": "POST", "url": "/login", "body": { ... } }, "response": [...] }\n  ]\n}' : isApifox ? '{\n  "apifoxProject": "项目名",\n  "info": { "name": "项目名" },\n  "apiCollection": [\n    { "name": "用户接口", "items": [\n      { "name": "登录", "api": { "method": "post", "path": "/login", "requestBody": { ... }, "responses": [...] } }\n    ]}\n  ]\n}' : isYapi ? '[\n  {\n    "name": "公共分类",\n    "list": [\n      { "_id": 1, "method": "GET", "path": "/api/user/list", "title": "用户列表", "req_query": [...] }\n    ]\n  }\n]' : '{\n  "openapi": "3.0.0",\n  "info": { "title": "Demo", "version": "1.0" },\n  "paths": { ... }\n}'}
            spellCheck={false}
          />
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-3 border-t border-gray-200 shrink-0">
          <button
            onClick={handleImport}
            disabled={importing || !!success}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {importing ? "识别导入中..." : "识别并导入"}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded-md hover:bg-gray-300 transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
