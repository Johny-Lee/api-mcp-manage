/**
 * Swagger 格式化测试 — 列表/过滤/详情
 */
import { describe, it, expect } from "vitest";
import { formatApiList, filterApiList, formatApiDetail, formatNotFound } from "./format.js";
import type { OpenApiDocument } from "../types.js";

const sampleDoc: OpenApiDocument = {
  openapi: "3.0.0",
  info: { title: "用户服务", version: "1.0.0", description: "用户中心 API" },
  paths: {
    "/api/v1/login": {
      post: {
        summary: "用户登录",
        operationId: "login",
        parameters: [
          { name: "username", in: "query", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { username: { type: "string" } } },
              example: { username: "john" },
            },
          },
        },
        responses: {
          "200": {
            description: "成功",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginResponse" },
                example: { token: "xxx" },
              },
            },
          },
        },
      },
    },
    "/api/v1/profile": {
      get: {
        summary: "获取个人信息",
        deprecated: false,
        responses: { "200": { description: "ok" } },
      },
      delete: {
        summary: "删除账号",
        deprecated: true,
        responses: { "204": { description: "已删除" } },
      },
    },
  },
  components: {
    schemas: {
      LoginResponse: {
        type: "object",
        properties: { token: { type: "string" } },
      },
    },
  },
};

describe("formatApiList", () => {
  it("生成包含所有接口的 Markdown 列表", () => {
    const md = formatApiList("用户服务", "proj_1", sampleDoc);
    expect(md).toContain("用户服务 (ID: proj_1)");
    expect(md).toContain("**POST** `/api/v1/login`");
    expect(md).toContain("**GET** `/api/v1/profile`");
    expect(md).toContain("**DELETE** `/api/v1/profile`");
    expect(md).toContain("用户登录");
  });

  it("标记废弃接口", () => {
    const md = formatApiList("用户服务", "proj_1", sampleDoc);
    expect(md).toContain("⚠️已废弃");
  });

  it("空 paths 显示提示", () => {
    const emptyDoc: OpenApiDocument = {
      info: { title: "空" },
      paths: {},
    };
    const md = formatApiList("空", "proj_1", emptyDoc);
    expect(md).toContain("暂无接口");
  });
});

describe("filterApiList", () => {
  it("按路径关键词过滤", () => {
    const filtered = filterApiList(sampleDoc, "login");
    expect(Object.keys(filtered.paths)).toHaveLength(1);
    expect(filtered.paths["/api/v1/login"]).toBeDefined();
  });

  it("按接口摘要关键词过滤", () => {
    const filtered = filterApiList(sampleDoc, "个人信息");
    expect(filtered.paths["/api/v1/profile"]).toBeDefined();
  });

  it("无匹配返回空 paths", () => {
    const filtered = filterApiList(sampleDoc, "nonexistent");
    expect(Object.keys(filtered.paths)).toHaveLength(0);
  });

  it("无关键词返回原文档", () => {
    const filtered = filterApiList(sampleDoc);
    expect(Object.keys(filtered.paths)).toHaveLength(2);
  });
});

describe("formatApiDetail", () => {
  it("生成包含参数表与响应的详情", () => {
    const op = sampleDoc.paths["/api/v1/login"].post!;
    const md = formatApiDetail("用户服务", "/api/v1/login", "post", op);
    expect(md).toContain("POST `/api/v1/login`");
    expect(md).toContain("用户登录");
    expect(md).toContain("请求参数");
    expect(md).toContain("username");
    expect(md).toContain("请求体");
    expect(md).toContain("application/json");
    expect(md).toContain("响应");
  });

  it("包含 schema JSON 代码块", () => {
    const op = sampleDoc.paths["/api/v1/login"].post!;
    const md = formatApiDetail("用户服务", "/api/v1/login", "post", op);
    expect(md).toContain("```json");
  });
});

describe("formatNotFound", () => {
  it("生成友好提示", () => {
    const md = formatNotFound("用户服务", "/api/none", "get");
    expect(md).toContain("未找到接口");
    expect(md).toContain("用户服务");
    expect(md).toContain("GET");
    expect(md).toContain("get_api_list");
  });
});
