/**
 * 局部 $ref 解引用测试 — OpenAPI 3.x / Swagger 2.x / 循环引用 / 嵌套引用
 */
import { describe, it, expect } from "vitest";
import { dereferenceNode } from "./dereference.js";
import type { OpenApiDocumentLike } from "./types-helpers.js";

const doc: OpenApiDocumentLike = {
  openapi: "3.0.0",
  info: { title: "test" },
  paths: {},
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { $ref: "#/components/schemas/Category" },
        },
      },
      Category: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
        },
      },
      // 循环引用：Node.parent → Node
      Node: {
        type: "object",
        properties: {
          value: { type: "string" },
          parent: { $ref: "#/components/schemas/Node" },
        },
      },
    },
    responses: {
      NotFound: { description: "not found" },
    },
  },
  definitions: {
    // Swagger 2.x
    LegacyUser: {
      type: "object",
      properties: { id: { type: "integer" } },
    },
  },
};

describe("dereferenceNode - 基础解析", () => {
  it("解析 OpenAPI 3.x $ref (#/components/schemas/)", () => {
    const schema = { $ref: "#/components/schemas/Category" };
    const result = dereferenceNode(schema, doc);
    expect(result.$ref).toBeUndefined();
    expect(result.type).toBe("object");
    expect(result.properties).toBeDefined();
    expect(result.properties.name.type).toBe("string");
  });

  it("解析 Swagger 2.x $ref (#/definitions/)", () => {
    const schema = { $ref: "#/definitions/LegacyUser" };
    const result = dereferenceNode(schema, doc);
    expect(result.$ref).toBeUndefined();
    expect(result.type).toBe("object");
    expect(result.properties.id.type).toBe("integer");
  });

  it("递归解析嵌套 $ref", () => {
    const schema = { $ref: "#/components/schemas/Pet" };
    const result = dereferenceNode(schema, doc);
    expect(result.$ref).toBeUndefined();
    expect(result.properties.name.type).toBe("string");
    // category 嵌套引用也应被解析
    expect(result.properties.category.$ref).toBeUndefined();
    expect(result.properties.category.type).toBe("object");
    expect(result.properties.category.properties.name.type).toBe("string");
  });

  it("不存在的 $ref 目标 → 保留原 $ref", () => {
    const schema = { $ref: "#/components/schemas/NonExistent" };
    const result = dereferenceNode(schema, doc);
    expect(result.$ref).toBe("#/components/schemas/NonExistent");
  });

  it("循环引用 → 返回占位（不无限递归）", () => {
    const schema = { $ref: "#/components/schemas/Node" };
    const result = dereferenceNode(schema, doc);
    expect(result.$ref).toBeUndefined();
    expect(result.properties.value.type).toBe("string");
    // parent 引用 Node 自身 → 应被占位
    expect(result.properties.parent.$circular_ref).toBe("#/components/schemas/Node");
  });
});

describe("dereferenceNode - 对象/数组遍历", () => {
  it("解析对象内非顶层 $ref 字段", () => {
    const node = {
      type: "object",
      properties: {
        cat: { $ref: "#/components/schemas/Category" },
      },
    };
    const result = dereferenceNode(node, doc);
    expect(result.type).toBe("object");
    expect(result.properties.cat.$ref).toBeUndefined();
    expect(result.properties.cat.properties.name.type).toBe("string");
  });

  it("解析数组元素中的 $ref", () => {
    const node = {
      type: "array",
      items: { $ref: "#/components/schemas/Category" },
    };
    const result = dereferenceNode(node, doc);
    expect(result.items.$ref).toBeUndefined();
    expect(result.items.type).toBe("object");
  });

  it("无 $ref 的节点原样返回（结构一致）", () => {
    const node = { type: "string", description: "plain" };
    const result = dereferenceNode(node, doc);
    expect(result).toEqual(node);
  });

  it("解析 responses 类型的 $ref", () => {
    const schema = { $ref: "#/components/responses/NotFound" };
    const result = dereferenceNode(schema, doc);
    expect(result.description).toBe("not found");
  });

  it("合并 $ref 同级的额外属性", () => {
    const schema = { $ref: "#/components/schemas/Category", description: "extra note" };
    const result = dereferenceNode(schema, doc);
    expect(result.$ref).toBeUndefined();
    expect(result.description).toBe("extra note");
    expect(result.type).toBe("object");
  });
});
