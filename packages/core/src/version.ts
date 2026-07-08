/**
 * 版本号 — 全项目唯一真相源
 *
 * 只在此处通过 package.json 读取版本，其余所有运行时展示
 * （MCP server info、启动横幅、Web 角标等）统一引用本文件，
 * 避免版本号散落导致的漂移。
 *
 * 升级版本时只需改 package.json 的 version 字段，本文件无需改动。
 */
import pkg from "../package.json";

/** 语义化版本号，例如 "1.4.0" */
export const VERSION: string = pkg.version;

/** 横幅 / 角标展示用版本，取主版本.次版本，例如 "V1.4" */
export const BANNER_VERSION: string = `V${VERSION.split(".").slice(0, 2).join(".")}`;
