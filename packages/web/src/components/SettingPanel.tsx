import { useState } from "react";
import { api, type SecurityInfo, type CacheSettingsInput } from "../api";

export default function SettingPanel({
  info,
  onReset,
}: {
  info: SecurityInfo | null;
  onReset: () => Promise<void>;
}) {
  const [resetting, setResetting] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleReset = async () => {
    if (!confirm("重置后将使旧 Token 立即失效，所有已连接的客户端需要更新配置。确定继续？")) return;
    setResetting(true);
    try {
      await onReset();
    } catch (err) {
      alert(err instanceof Error ? err.message : "重置失败");
    } finally {
      setResetting(false);
    }
  };

  const copyText = async (text: string) => {
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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!info) {
    return <div className="text-center py-12 text-gray-500">加载中...</div>;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-700">⚙️ 设置</h2>

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
            onClick={() => copyText(info.mcpClientToken)}
            className="ml-2 px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300 transition-colors shrink-0"
          >
            {copied ? "✅ 已复制" : "📋 复制"}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          MCP 端点: <code className="bg-gray-100 px-1 rounded">{info.mcpEndpoint}</code> · 端口: {info.port}
        </p>
      </div>

      {/* 缓存配置 */}
      <CacheSettingsCard info={info} />
    </div>
  );
}

// ════════════════════════════════════════════════
// 缓存配置卡片
// ════════════════════════════════════════════════

/** 默认 TTL 2 小时 */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** 毫秒 → { value, unit }（单位：分钟/小时） */
function msToValueUnit(ms: number | undefined): { value: string; unit: "minutes" | "hours" } {
  const v = ms || DEFAULT_TTL_MS;
  if (v % (60 * 60 * 1000) === 0) {
    return { value: String(v / (60 * 60 * 1000)), unit: "hours" };
  }
  return { value: String(Math.round(v / (60 * 1000))), unit: "minutes" };
}

/** { value, unit } → 毫秒 */
function valueUnitToMs(value: string, unit: "minutes" | "hours"): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) return DEFAULT_TTL_MS;
  return unit === "hours" ? n * 60 * 60 * 1000 : n * 60 * 1000;
}

function CacheSettingsCard({ info }: { info: SecurityInfo }) {
  const cache = info.cache;
  const initialType = cache?.type || "memory";
  const initialTtl = msToValueUnit(cache?.ttlMs);
  const initialRedisUrl = cache?.redis?.url || "";
  const initialRedisPrefix = cache?.redis?.keyPrefix || "api-mcp:cache:";
  const initialRedisTls = cache?.redis?.tls || false;

  const [cacheType, setCacheType] = useState<"memory" | "redis">(initialType);
  const [ttlValue, setTtlValue] = useState(initialTtl.value);
  const [ttlUnit, setTtlUnit] = useState<"minutes" | "hours">(initialTtl.unit);
  const [redisUrl, setRedisUrl] = useState(initialRedisUrl);
  const [redisPrefix, setRedisPrefix] = useState(initialRedisPrefix);
  const [redisTls, setRedisTls] = useState(initialRedisTls);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // 检测是否有改动
  const ttlMs = valueUnitToMs(ttlValue, ttlUnit);
  const changed =
    cacheType !== initialType ||
    ttlMs !== (cache?.ttlMs || DEFAULT_TTL_MS) ||
    (cacheType === "redis" &&
      (redisUrl !== initialRedisUrl ||
        redisPrefix !== initialRedisPrefix ||
        redisTls !== initialRedisTls));

  /** 前端字段校验 */
  function validate(): string | null {
    const n = parseInt(ttlValue, 10);
    if (isNaN(n) || n <= 0) return "缓存有效期必须为正整数";
    if (cacheType === "redis" && !redisUrl.trim()) return "Redis 模式必须填写连接地址";
    return null;
  }

  /** 构造提交数据 */
  function buildInput(): CacheSettingsInput {
    return {
      cache_type: cacheType,
      cache_ttl_ms: ttlMs,
      ...(cacheType === "redis"
        ? { cache_redis: { url: redisUrl.trim(), keyPrefix: redisPrefix.trim() || undefined, tls: redisTls } }
        : { cache_redis: undefined }),
    };
  }

  const handleSave = async () => {
    setMsg(null);
    // 1. 前端校验
    const err = validate();
    if (err) {
      setMsg({ type: "error", text: err });
      return;
    }

    // 2. 测试连接（redis 模式）
    if (cacheType === "redis") {
      setTesting(true);
      try {
        const input = buildInput();
        const result = await api.testCacheSettings(input);
        if (!result.ok) {
          setMsg({ type: "error", text: `Redis 连接测试失败：${result.error || "未知错误"}` });
          return;
        }
      } catch (e) {
        setMsg({ type: "error", text: e instanceof Error ? e.message : "测试连接失败" });
        return;
      } finally {
        setTesting(false);
      }
    }

    // 3. 弹层确认（提示需重启 + 清缓存）
    const confirmed = confirm(
      "⚠️ 修改缓存配置后需要重启服务才能生效，重启期间服务会短暂不可用，且当前缓存将被清除。\n\n确定要保存并重启服务吗？",
    );
    if (!confirmed) return;

    // 4. 提交保存
    setSaving(true);
    try {
      const input = buildInput();
      const result = await api.updateCacheSettings(input);
      if (result.ok) {
        setMsg({
          type: "success",
          text: "✅ 缓存设置已保存，服务正在重启。页面将在 3 秒后刷新…",
        });
        // 服务重启后延迟刷新页面
        setTimeout(() => window.location.reload(), 3000);
      } else {
        setMsg({ type: "error", text: result.message || "保存失败" });
      }
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const activeKind = cache?.activeKind || "memory";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-medium text-gray-700">接口数据缓存</h3>
        {/* 当前生效模式标签 */}
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            activeKind === "redis"
              ? "bg-red-50 text-red-600"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          当前生效: {activeKind === "redis" ? "Redis" : "Memory"}
        </span>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        接口文档拉取后缓存的存储方式与有效期。切换缓存类型或修改配置后需重启服务生效。
      </p>

      {/* 缓存类型选择 */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1.5">缓存类型</label>
        <div className="flex gap-2">
          {(["memory", "redis"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setCacheType(t)}
              className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                cacheType === t
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
              }`}
            >
              {t === "memory" ? "💾 内存（默认）" : "🗄️ Redis"}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-400">
          {cacheType === "memory"
            ? "单机内存缓存，进程重启后丢失，零依赖"
            : "跨进程共享缓存，支持多实例部署，依赖 Redis 服务"}
        </p>
      </div>

      {/* 缓存有效期 */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1.5">缓存有效期</label>
        <div className="flex gap-2 items-center">
          <input
            type="number"
            min={1}
            value={ttlValue}
            onChange={(e) => setTtlValue(e.target.value)}
            className="w-32 border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <select
            value={ttlUnit}
            onChange={(e) => setTtlUnit(e.target.value as "minutes" | "hours")}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
          >
            <option value="minutes">分钟</option>
            <option value="hours">小时</option>
          </select>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          过期后下次访问自动重新拉取上游文档
        </p>
      </div>

      {/* Redis 配置（仅 redis 模式显示） */}
      {cacheType === "redis" && (
        <div className="mb-4 p-4 bg-gray-50 rounded-md border border-gray-200 space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Redis 连接地址 <span className="text-red-500">*</span>
            </label>
            <input
              value={redisUrl}
              onChange={(e) => setRedisUrl(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
              placeholder="redis://localhost:6379 或 rediss://...（含密码: redis://:password@host:port）"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Key 前缀（可选）</label>
            <input
              value={redisPrefix}
              onChange={(e) => setRedisPrefix(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
              placeholder="api-mcp:cache:"
            />
            <p className="mt-1 text-xs text-gray-400">多实例部署时用于隔离不同实例的缓存</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="redis-tls"
              checked={redisTls}
              onChange={(e) => setRedisTls(e.target.checked)}
              className="rounded border-gray-300"
            />
            <label htmlFor="redis-tls" className="text-sm text-gray-700">
              启用 TLS（使用 rediss:// 协议时自动启用）
            </label>
          </div>
        </div>
      )}

      {/* 提示信息 */}
      {msg && (
        <div
          className={`mb-3 p-2.5 rounded-md text-sm ${
            msg.type === "success"
              ? "bg-green-50 border border-green-200 text-green-700"
              : "bg-red-50 border border-red-200 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={!changed || saving || testing}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {testing ? "测试连接中..." : saving ? "保存中..." : "保存并重启"}
        </button>
        {!changed && (
          <span className="text-xs text-gray-400">配置无变动</span>
        )}
      </div>
    </div>
  );
}
