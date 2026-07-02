import { createLogger, format, transports } from "winston";

const { combine, timestamp, printf, colorize } = format;

/** 自定义格式：时间 + 级别 + 消息 + 可选元数据 */
const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

/** 脱敏 query token：把 URL 中的 ?token=xxx 或 &token=xxx 替换为 token=*** */
function sanitizeUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/gi, "$1***");
}

/** 脱敏敏感字段的对象浅拷贝 */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "url" && typeof v === "string") {
      out[k] = sanitizeUrl(v);
    } else if (k === "token" || k === "mcp_client_token" || k === "authorization") {
      out[k] = "***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const logger = createLogger({
  level: process.env.MCP_LOG_LEVEL || "info",
  format: combine(
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format((info) => {
      // 脱敏 info 顶层的 url/token 字段
      if (typeof info.message === "string") {
        info.message = sanitizeUrl(info.message);
      }
      const meta: Record<string, unknown> = {};
      for (const k of Object.keys(info)) {
        if (!["level", "message", "timestamp"].includes(k)) {
          meta[k] = (info as Record<string, unknown>)[k];
          delete (info as Record<string, unknown>)[k];
        }
      }
      Object.assign(info, sanitizeMeta(meta));
      return info;
    })(),
    logFormat,
  ),
  transports: [
    new transports.Console({
      format: combine(colorize(), logFormat),
    }),
  ],
});
