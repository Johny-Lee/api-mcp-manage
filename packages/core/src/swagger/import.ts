import type { ApiSource, OpenApiDocument } from "../types.js";
import { validateOpenApi } from "./cache.js";
import { normalizeDocument } from "./normalize.js";
import { convertYapiToOpenApi, type YapiInterfaceDetail } from "./yapi.js";
import { convertApifoxToOpenApi, type ApifoxExport } from "./apifox.js";
import { convertPostmanToOpenApi, isPostmanCollection, type PostmanCollection } from "./postman.js";

/**
 * 导入 JSON 文档支持
 *
 * 用于「导入 JSON」模式：用户在导入弹层粘贴 JSON 文本，按项目 source 类型
 * 校验并转换为统一的 OpenApiDocument，持久化到项目配置中。
 *
 * - source=swagger：JSON 须为 OpenAPI 3.x / Swagger 2.x 文档（含 openapi/swagger + paths）
 * - source=yapi：JSON 须为 YApi 接口详情数组，或 YApi 数据导出格式（含分组的 list）
 * - source=apifox：JSON 须为 Apifox 数据导出格式（含 apiCollection 嵌套 folder/api 树）
 * - source=postman：JSON 须为 Postman Collection v2.1/v2.0 导出格式（含 item 数组）
 *
 * 校验失败抛 Error（含可读原因），由调用方捕获后返回前端。
 */

/**
 * 校验并转换导入的 JSON 文本为 OpenApiDocument
 *
 * @param source 项目文档来源类型，决定校验格式
 * @param rawJson 用户粘贴的原始 JSON 文本
 * @param title 文档标题（项目名，yapi/apifox 源转换时使用；swagger 源保留文档自带 info.title）
 * @returns 校验通过且转换后的 OpenApiDocument
 * @throws Error JSON 解析失败或结构不符合对应格式时
 */
export function parseImportedDoc(
  source: ApiSource,
  rawJson: string,
  title: string,
): OpenApiDocument {
  const trimmed = rawJson.trim();
  if (!trimmed) {
    throw new Error("JSON 内容为空");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }

  if (source === "yapi") {
    return parseYapiImport(parsed, title);
  }
  if (source === "apifox") {
    return parseApifoxImport(parsed, title);
  }
  if (source === "postman") {
    return parsePostmanImport(parsed, title);
  }
  // 默认 swagger
  return parseSwaggerImport(parsed);
}

/** 校验并转换 Swagger/OpenAPI 文档 */
function parseSwaggerImport(parsed: unknown): OpenApiDocument {
  // 复用 cache.ts 的结构校验（识别 openapi/swagger + paths）
  const validated = validateOpenApi(parsed);
  // 归一化 Swagger 2.x -> OpenAPI 3.x（OpenAPI 3.x 原样深拷贝）
  return normalizeDocument(validated);
}

/**
 * 校验并转换 Apifox 数据导出格式
 *
 * 期望格式：Apifox 项目「数据导出 -> Apifox」JSON，顶层含 apiCollection 数组
 * （嵌套 folder/api 树）。兼容旧版 collection 字段。两者皆无时抛错。
 */
function parseApifoxImport(parsed: unknown, title: string): OpenApiDocument {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Apifox 导入格式须为数据导出 JSON 对象（含 apiCollection 字段）");
  }
  const obj = parsed as Partial<ApifoxExport>;
  if (!Array.isArray(obj.apiCollection) && !Array.isArray(obj.collection)) {
    throw new Error("Apifox 导出缺少 apiCollection 字段（请使用 Apifox「数据导出 -> Apifox」格式）");
  }
  return convertApifoxToOpenApi(obj as ApifoxExport, title);
}

/**
 * 校验并转换 Postman Collection 导出格式
 *
 * 期望格式：Postman Collection v2.1/v2.0 导出 JSON，顶层含 item 数组
 * （嵌套 folder/request 树）与 info.schema 标识。无 item 时抛错。
 */
function parsePostmanImport(parsed: unknown, title: string): OpenApiDocument {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Postman 导入格式须为 Collection 导出 JSON 对象（含 item 字段）");
  }
  if (!isPostmanCollection(parsed)) {
    throw new Error("Postman 导出缺少 item 字段（请使用 Postman「Export → Collection v2.1」格式）");
  }
  return convertPostmanToOpenApi(parsed as PostmanCollection, title);
}

/**
 * 校验并转换 YApi 原生接口详情数组
 *
 * 支持两种 YApi JSON 形态：
 * 1. 接口详情扁平数组（/api/interface/get 返回结构的数组），每项含
 *    _id / path / method / req_query / req_body_type 等
 * 2. YApi 数据导出格式（项目数据迁移导出），形如
 *    [{ _id, name, desc, list: [接口详情...] }, ...]，每个分组的 list 含接口详情
 *    分组的 name 会被注入为各接口的 catname（菜单名），用于 summary 拼接
 */
function parseYapiImport(parsed: unknown, title: string): OpenApiDocument {
  if (!Array.isArray(parsed)) {
    throw new Error("YApi 导入格式须为接口详情数组或数据导出数组（含分组的 list）");
  }
  if (parsed.length === 0) {
    throw new Error("YApi 导入数组为空，无可导入的接口");
  }

  // 检测是否为分组导出格式：首个元素为对象且含 list 数组
  const first = parsed[0];
  const isGrouped =
    first && typeof first === "object" && !Array.isArray(first) && Array.isArray((first as { list?: unknown }).list);

  let details: YapiInterfaceDetail[];
  if (isGrouped) {
    details = [];
    for (const group of parsed) {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        throw new Error("YApi 导出数组元素须为对象");
      }
      const g = group as { name?: string; list?: unknown[] };
      const catname = typeof g.name === "string" ? g.name : "";
      const list = Array.isArray(g.list) ? g.list : [];
      for (const item of list) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("YApi 导出分组 list 元素须为对象（单接口详情）");
        }
        // 注入菜单名（详情本身无 catname，从分组 name 填充）
        (item as YapiInterfaceDetail).catname = catname;
        details.push(item as YapiInterfaceDetail);
      }
    }
  } else {
    // 扁平接口详情数组：逐项校验为对象
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("YApi 导入数组元素须为对象（单接口详情）");
      }
    }
    details = parsed as YapiInterfaceDetail[];
  }

  if (details.length === 0) {
    throw new Error("YApi 导入分组 list 均为空，无可导入的接口");
  }

  return convertYapiToOpenApi(details, title);
}
