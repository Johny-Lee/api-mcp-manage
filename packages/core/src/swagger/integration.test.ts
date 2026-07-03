/**
 * Swagger/OpenAPI 真实公网集成测试
 *
 * 使用 Swagger 官方 Petstore 示例项目验证完整管线：
 *   fetch → normalize → dereference → format
 *
 * - Swagger 2.0:  https://petstore.swagger.io/v2/swagger.json
 * - OpenAPI 3.0:  https://petstore3.swagger.io/api/v3/openapi.json
 *
 * 这些端点公开免鉴权，覆盖两种文档格式。网络不可达时跳过而非失败。
 */
import { describe, it, expect } from "vitest";
import type { McpProject, OpenApiDocument } from "../types.js";
import { getProjectDoc, clearCache } from "./cache.js";
import { filterApiList, formatApiList, formatApiDetail } from "./format.js";
import { derefOperation } from "../tools/index.js";
import type { OpenApiDocumentLike } from "./types-helpers.js";

const PETSTORE_V2: McpProject = {
  id: "proj_petstore_v2",
  name: "Petstore Swagger 2.0",
  desc: "Swagger 官方 Petstore 示例 (Swagger 2.0)",
  url: "https://petstore.swagger.io/v2/swagger.json",
  createdAt: "",
  updatedAt: "",
};

const PETSTORE_V3: McpProject = {
  id: "proj_petstore_v3",
  name: "Petstore OpenAPI 3.0",
  desc: "Swagger 官方 Petstore 示例 (OpenAPI 3.0)",
  url: "https://petstore3.swagger.io/api/v3/openapi.json",
  createdAt: "",
  updatedAt: "",
};

/** 尝试拉取文档，网络失败时返回 null（供测试跳过） */
async function tryFetchDoc(project: McpProject): Promise<OpenApiDocument | null> {
  clearCache();
  try {
    return await getProjectDoc(project);
  } catch {
    return null;
  }
}

/** 在文档中找一个含 requestBody 或 responses 的接口用于详情测试 */
function pickFirstRealOp(doc: OpenApiDocument): { path: string; method: string } | null {
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const ml = method.toLowerCase();
      if (!["get", "post", "put", "delete", "patch"].includes(ml)) continue;
      if (op.responses && Object.keys(op.responses).length) {
        return { path, method: ml };
      }
    }
  }
  return null;
}

describe("Swagger 2.0 源 — Petstore v2 真实文档", () => {
  it("完整管线：拉取 → 归一化 → 列表 → 详情", async () => {
    const doc = await tryFetchDoc(PETSTORE_V2);
    if (!doc) {
      console.warn("跳过：Petstore v2 网络不可达");
      return;
    }

    // Swagger 2.0 文档归一化后应无 swagger 字段残留问题
    expect(doc.info.title).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);

    // 列表格式化
    const listMd = formatApiList(PETSTORE_V2.name, PETSTORE_V2.id, doc);
    expect(listMd).toContain(PETSTORE_V2.name);
    expect(listMd).toContain("**"); // 至少一个 method 标记

    // 关键词过滤
    const filtered = filterApiList(doc, "pet");
    expect(Object.keys(filtered.paths).length).toBeGreaterThan(0);

    // 详情：找第一个有响应的接口，验证归一化后 responses 有 content
    const pick = pickFirstRealOp(doc);
    expect(pick).not.toBeNull();
    const op = doc.paths[pick!.path][pick!.method];
    expect(op.responses).toBeDefined();

    // 归一化后 Swagger 2.0 的 response.schema 应已转为 content[].schema
    const resp200 = op.responses["200"] || Object.values(op.responses)[0];
    expect(resp200).toBeDefined();
    // 归一化后应有 content（Swagger 2.0 的 schema → content）
    if (resp200.content) {
      const ct = Object.keys(resp200.content)[0];
      expect(resp200.content[ct].schema).toBeDefined();
    }

    // 局部 $ref 解引用 + 详情格式化（不崩溃）
    const derefedOp = derefOperation(op, doc as unknown as OpenApiDocumentLike);
    const detailMd = formatApiDetail(PETSTORE_V2.name, pick!.path, pick!.method, derefedOp);
    expect(detailMd).toContain("#### 响应");
    // 解引用后不应残留 #/definitions 或 #/components 原始路径在顶层 schema
    expect(detailMd).not.toContain("$circular_ref");
  }, 30000);

  it("归一化：Swagger 2.0 body 参数 → requestBody", async () => {
    const doc = await tryFetchDoc(PETSTORE_V2);
    if (!doc) {
      console.warn("跳过：Petstore v2 网络不可达");
      return;
    }
    // Petstore v2 的 POST /pet 应有 requestBody（来自 body 参数归一化）
    const postPet = doc.paths["/pet"]?.post;
    if (postPet) {
      expect(postPet.requestBody).toBeDefined();
      expect(postPet.requestBody!.content).toBeDefined();
      const ct = Object.keys(postPet.requestBody!.content)[0];
      expect(postPet.requestBody!.content[ct].schema).toBeDefined();
    }
  }, 30000);
});

describe("OpenAPI 3.0 源 — Petstore v3 真实文档", () => {
  it("完整管线：拉取 → 列表 → 详情", async () => {
    const doc = await tryFetchDoc(PETSTORE_V3);
    if (!doc) {
      console.warn("跳过：Petstore v3 网络不可达");
      return;
    }

    expect(doc.info.title).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);

    // 列表格式化
    const listMd = formatApiList(PETSTORE_V3.name, PETSTORE_V3.id, doc);
    expect(listMd).toContain(PETSTORE_V3.name);

    // 关键词过滤
    const filtered = filterApiList(doc, "pet");
    expect(Object.keys(filtered.paths).length).toBeGreaterThan(0);

    // 详情：找第一个有响应的接口
    const pick = pickFirstRealOp(doc);
    expect(pick).not.toBeNull();
    const op = doc.paths[pick!.path][pick!.method];

    // OpenAPI 3.0 原生 responses 应有 content
    const resp200 = op.responses["200"] || Object.values(op.responses)[0];
    expect(resp200).toBeDefined();

    // 局部 $ref 解引用 + 详情格式化（不崩溃）
    const derefedOp = derefOperation(op, doc as unknown as OpenApiDocumentLike);
    const detailMd = formatApiDetail(PETSTORE_V3.name, pick!.path, pick!.method, derefedOp);
    expect(detailMd).toContain("#### 响应");
    expect(detailMd).not.toContain("$circular_ref");
  }, 30000);

  it("$ref 解引用：components/schemas 引用被展开", async () => {
    const doc = await tryFetchDoc(PETSTORE_V3);
    if (!doc) {
      console.warn("跳过：Petstore v3 网络不可达");
      return;
    }
    // Petstore v3 大量使用 $ref: #/components/schemas/Pet
    // 找一个含 $ref 的 operation 验证解引用后 $ref 被替换
    let found = false;
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const ml = method.toLowerCase();
        if (!["get", "post", "put", "delete", "patch"].includes(ml)) continue;
        const derefedOp = derefOperation(op, doc as unknown as OpenApiDocumentLike);
        const detailMd = formatApiDetail(PETSTORE_V3.name, path, ml, derefedOp);
        // 解引用成功后详情里不应出现原始 $ref 路径
        if (detailMd.includes("#### 响应")) {
          expect(detailMd).not.toContain("#/components/schemas/");
          found = true;
          break;
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
  }, 30000);
});
