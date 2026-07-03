import { useState, useEffect, useMemo } from "react";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { api, type ApiItem } from "../api";

/**
 * 配置 marked：代码块用 highlight.js 做语法高亮。
 * 仅配置一次（模块级），避免每次渲染重复初始化。
 */
marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      try {
        return hljs.highlight(code, { language }).value;
      } catch {
        return code;
      }
    },
  }),
);

/** 请求方法 → Tailwind 配色（与接口列表保持一致） */
function methodColor(method: string): string {
  const map: Record<string, string> = {
    GET: "bg-green-100 text-green-700",
    POST: "bg-blue-100 text-blue-700",
    PUT: "bg-orange-100 text-orange-700",
    DELETE: "bg-red-100 text-red-700",
    PATCH: "bg-purple-100 text-purple-700",
  };
  return map[method] || "bg-gray-100 text-gray-700";
}

export default function ApiDetailModal({
  projectId,
  api: apiItem,
  onClose,
}: {
  projectId: string;
  api: ApiItem;
  onClose: () => void;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const data = await api.getApiDetail(projectId, apiItem.path, apiItem.method);
        if (!cancelled) setMarkdown(data.markdown);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, apiItem.path, apiItem.method]);

  // Markdown → HTML（高亮已在 marked 配置中处理）→ 净化
  const html = useMemo(() => {
    if (!markdown) return "";
    const raw = marked.parse(markdown, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [markdown]);

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
          <span
            className={`text-xs font-mono font-bold px-2 py-1 rounded min-w-[60px] text-center ${methodColor(apiItem.method)}`}
          >
            {apiItem.method}
          </span>
          <code className="text-sm text-gray-800 font-mono flex-1 truncate" title={apiItem.path}>
            {apiItem.path}
          </code>
          {apiItem.summary && (
            <span className="text-sm text-gray-500 truncate max-w-[35%]" title={apiItem.summary}>
              {apiItem.summary}
            </span>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2"
            title="关闭"
          >
            ×
          </button>
        </div>

        {/* Body — flex-1 + min-h-0 让 overflow-y-auto 在 flex 列中生效 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {loading && <div className="text-center py-12 text-gray-500">加载接口详情中...</div>}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
              {error}
            </div>
          )}

          {!loading && !error && markdown && (
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </div>
    </div>
  );
}
