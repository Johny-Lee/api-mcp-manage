/**
 * tools 层局部解引用 + format 类型可读性测试
 */
import { describe, it, expect } from "vitest";
import { derefOperation } from "./index.js";
import { formatApiDetail } from "../swagger/format.js";
import type { OpenApiOperation } from "../types.js";
import type { OpenApiDocumentLike } from "../swagger/types-helpers.js";

const doc: OpenApiDocumentLike = {
  components: {
    schemas: {
      Pet: { type: "object", properties: { name: { type: "string" } } },
      Tag: { type: "object", properties: { id: { type: "integer" } } },
    },
    parameters: {
      PetIdParam: { name: "petId", in: "path", required: true, schema: { type: "integer" } },
    },
  },
};

describe("derefOperation — parameters 解引用", () => {
  it("解引用 parameter.schema 内的 $ref", () => {
    const op: OpenApiOperation = {
      parameters: [
        { name: "body", in: "body", schema: { $ref: "#/components/schemas/Pet" } },
      ],
    };
    const out = derefOperation(op, doc);
    expect(out.parameters![0].schema).toBeDefined();
    expect((out.parameters![0].schema as Record<string, unknown>).$ref).toBeUndefined();
    expect((out.parameters![0].schema as Record<string, unknown>).type).toBe("object");
  });

  it("解引用 parameter 本身是 $ref（#/components/parameters/）", () => {
    const op: OpenApiOperation = {
      parameters: [{ $ref: "#/components/parameters/PetIdParam" } as unknown as OpenApiOperation["parameters"][number]],
    };
    const out = derefOperation(op, doc);
    expect(out.parameters![0].name).toBe("petId");
    expect(out.parameters![0].in).toBe("path");
  });

  it("未命中目标的 $ref schema 保留（不崩溃）", () => {
    const op: OpenApiOperation = {
      parameters: [
        { name: "x", in: "query", schema: { $ref: "#/components/schemas/Missing" } },
      ],
    };
    const out = derefOperation(op, doc);
    // 残留 $ref
    expect((out.parameters![0].schema as Record<string, unknown>).$ref).toBe("#/components/schemas/Missing");
  });
});

describe("derefOperation — requestBody / responses", () => {
  it("requestBody schema 解引用", () => {
    const op: OpenApiOperation = {
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
    };
    const out = derefOperation(op, doc);
    const schema = out.requestBody!.content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.$ref).toBeUndefined();
  });

  it("response schema 解引用", () => {
    const op: OpenApiOperation = {
      responses: {
        "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Tag" } } } },
      },
    };
    const out = derefOperation(op, doc);
    const schema = out.responses!["200"].content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });
});

describe("formatApiDetail — paramType 可读性", () => {
  it("解引用后的 object schema 显示为 object（非原始 $ref）", () => {
    const op: OpenApiOperation = {
      summary: "t",
      parameters: [
        { name: "body", in: "body", schema: { type: "object", properties: { name: { type: "string" } } } },
      ],
    };
    const md = formatApiDetail("Proj", "/p", "post", op);
    // 参数表应含 object 类型
    expect(md).toContain("| `body` | body | object |");
  });

  it("数组 schema 显示为 array<inner>", () => {
    const op: OpenApiOperation = {
      summary: "t",
      parameters: [
        { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
      ],
    };
    const md = formatApiDetail("Proj", "/p", "get", op);
    expect(md).toContain("array<string>");
  });

  it("未解引用的残留 $ref 显示短名（ref: X）", () => {
    const op: OpenApiOperation = {
      summary: "t",
      parameters: [
        { name: "body", in: "body", schema: { $ref: "#/components/schemas/UnknownThing" } },
      ],
    };
    const md = formatApiDetail("Proj", "/p", "post", op);
    expect(md).toContain("ref: UnknownThing");
    // 不应出现完整路径
    expect(md).not.toContain("#/components/schemas/UnknownThing");
  });

  it("原始类型 schema 直接显示类型名", () => {
    const op: OpenApiOperation = {
      summary: "t",
      parameters: [
        { name: "id", in: "query", schema: { type: "integer", format: "int64" } },
      ],
    };
    const md = formatApiDetail("Proj", "/p", "get", op);
    expect(md).toContain("| `id` | query | integer |");
  });
});
