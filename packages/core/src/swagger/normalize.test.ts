/**
 * Swagger 2.0 → OpenAPI 3.x 归一化测试
 */
import { describe, it, expect } from "vitest";
import { normalizeDocument } from "./normalize.js";
import type { OpenApiDocument } from "../types.js";

/** 构造一个最小 Swagger 2.0 文档（含 body / formData / 响应 schema） */
function swagger2Doc(): OpenApiDocument {
  return {
    swagger: "2.0",
    info: { title: "Demo", version: "1.0" },
    paths: {
      "/pet": {
        post: {
          summary: "Add pet",
          parameters: [
            { name: "body", in: "body", required: true, description: "Pet body", schema: { $ref: "#/definitions/Pet" } },
          ],
          responses: {
            "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } },
            "405": { description: "Invalid input" },
          },
        },
        put: {
          summary: "Update pet via form",
          parameters: [
            { name: "name", in: "formData", required: true, type: "string" },
            { name: "status", in: "formData", required: false, type: "string", enum: ["available", "pending"] },
            { name: "X-Trace", in: "header", required: false, type: "string" },
          ],
          responses: { "204": { description: "done" } },
        },
      },
    },
    // @ts-expect-error — Swagger 2.x 特有字段，不在 OpenApiDocument 类型内
    definitions: {
      Pet: { type: "object", properties: { name: { type: "string" } } },
    },
    // @ts-expect-error
    consumes: ["application/json"],
    // @ts-expect-error
    produces: ["application/json"],
  } as OpenApiDocument;
}

function openapi3Doc(): OpenApiDocument {
  return {
    openapi: "3.0.0",
    info: { title: "Demo3", version: "1.0" },
    paths: {
      "/pet": {
        post: {
          summary: "Add pet",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
          responses: {
            "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
          },
        },
      },
    },
    components: { schemas: { Pet: { type: "object", properties: { name: { type: "string" } } } } },
  };
}

describe("normalizeDocument — Swagger 2.x 转换", () => {
  it("body 参数 → requestBody.content[application/json].schema", () => {
    const out = normalizeDocument(swagger2Doc());
    const op = out.paths["/pet"].post;
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody!.required).toBe(true);
    expect(op.requestBody!.content["application/json"].schema).toEqual({ $ref: "#/definitions/Pet" });
    // body 参数不再出现在 parameters
    expect(op.parameters).toBeUndefined();
  });

  it("响应 schema → content[application/json].schema（200），无 schema 的响应无 content（405）", () => {
    const out = normalizeDocument(swagger2Doc());
    const op = out.paths["/pet"].post;
    expect(op.responses["200"].content).toBeDefined();
    expect(op.responses["200"].content!["application/json"].schema).toEqual({ $ref: "#/definitions/Pet" });
    expect(op.responses["405"].content).toBeUndefined();
    expect(op.responses["405"].description).toBe("Invalid input");
  });

  it("formData 参数 → 合并为 requestBody object schema，header 参数保留", () => {
    const out = normalizeDocument(swagger2Doc());
    const op = out.paths["/pet"].put;
    expect(op.requestBody).toBeDefined();
    const schema = op.requestBody!.content["application/x-www-form-urlencoded"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>).name).toEqual({ type: "string" });
    expect((schema.required as string[])).toEqual(["name"]);
    // header 参数保留在 parameters
    expect(op.parameters).toBeDefined();
    expect(op.parameters![0].name).toBe("X-Trace");
    expect(op.parameters![0].in).toBe("header");
  });

  it("归一化不修改原始文档（深拷贝）", () => {
    const doc = swagger2Doc();
    const originalParams = (doc.paths["/pet"].post.parameters as { length: number }).length;
    normalizeDocument(doc);
    expect((doc.paths["/pet"].post.parameters as { length: number }).length).toBe(originalParams);
    // 原文档仍保留 body 参数
    expect(doc.paths["/pet"].post.parameters![0].in).toBe("body");
  });
});

describe("normalizeDocument — OpenAPI 3.x 原样透传", () => {
  it("OpenAPI 3.x 文档结构不变（深拷贝）", () => {
    const doc = openapi3Doc();
    const out = normalizeDocument(doc);
    const op = out.paths["/pet"].post;
    expect(op.requestBody!.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Pet" });
    expect(op.responses["200"].content!["application/json"].schema).toEqual({ $ref: "#/components/schemas/Pet" });
  });

  it("透传产出是新对象（不与原对象引用共享）", () => {
    const doc = openapi3Doc();
    const out = normalizeDocument(doc);
    expect(out).not.toBe(doc);
    expect(out.paths).not.toBe(doc.paths);
  });
});
