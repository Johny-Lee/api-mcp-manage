/**
 * parseImportedDoc 测试（导入 JSON 校验+转换）
 *
 * 覆盖：
 * - swagger 源：OpenAPI 3.x 合法 / Swagger 2.x 归一化 / 非 OpenAPI 抛错 / JSON 解析失败
 * - yapi 源：接口详情数组合法 / 非数组 / 空数组 / 非对象元素
 * - 空内容
 */
import { describe, it, expect } from "vitest";
import { parseImportedDoc } from "./import.js";

const TITLE = "Demo";

describe("parseImportedDoc — swagger 源", () => {
  it("OpenAPI 3.x 文档校验通过并原样返回 paths", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "Pet", version: "1.0" },
      paths: {
        "/pet": {
          get: { summary: "list pets", responses: { "200": { description: "ok" } } },
        },
      },
    };
    const result = parseImportedDoc("swagger", JSON.stringify(doc), TITLE);
    expect(result.openapi).toBe("3.0.0");
    expect(result.paths["/pet"].get).toBeDefined();
    expect(result.paths["/pet"].get!.summary).toBe("list pets");
  });

  it("Swagger 2.x 文档归一化为 OpenAPI 3.x（body 参数 → requestBody）", () => {
    const doc = {
      swagger: "2.0",
      info: { title: "Pet", version: "1.0" },
      paths: {
        "/pet": {
          post: {
            summary: "add pet",
            parameters: [
              { name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Pet" } },
            ],
            responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } },
          },
        },
      },
      definitions: { Pet: { type: "object", properties: { name: { type: "string" } } } },
    };
    const result = parseImportedDoc("swagger", JSON.stringify(doc), TITLE);
    const op = result.paths["/pet"].post!;
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody!.content!["application/json"]).toBeDefined();
  });

  it("缺少 paths 字段抛错", () => {
    const doc = { openapi: "3.0.0", info: { title: "x", version: "1" } };
    expect(() => parseImportedDoc("swagger", JSON.stringify(doc), TITLE)).toThrow(/paths/);
  });

  it("非 OpenAPI/Swagger 文档抛错", () => {
    const doc = { foo: "bar" };
    expect(() => parseImportedDoc("swagger", JSON.stringify(doc), TITLE)).toThrow(/无法识别/);
  });

  it("JSON 解析失败抛错", () => {
    expect(() => parseImportedDoc("swagger", "{invalid json", TITLE)).toThrow(/JSON 解析失败/);
  });
});

describe("parseImportedDoc — yapi 源", () => {
  it("接口详情数组合法：转换为 OpenApiDocument", () => {
    const arr = [
      {
        _id: 1,
        project_id: 10,
        catid: 100,
        method: "GET",
        path: "/user/list",
        title: "用户列表",
        req_query: [{ name: "page", desc: "页码", required: "1" }],
      },
    ];
    const result = parseImportedDoc("yapi", JSON.stringify(arr), TITLE);
    expect(result.openapi).toBe("3.0.0");
    expect(result.info.title).toBe(TITLE);
    expect(result.paths["/user/list"].get).toBeDefined();
    expect(result.paths["/user/list"].get!.parameters).toBeDefined();
  });

  it("数据导出格式（分组含 list）：展平并注入 catname", () => {
    const groups = [
      {
        _id: 100,
        name: "公共分类",
        desc: "公共接口",
        list: [
          {
            _id: 1,
            method: "GET",
            path: "/health",
            title: "健康检查",
            req_query: [{ name: "t", desc: "时间戳", required: "0" }],
          },
        ],
      },
      {
        _id: 200,
        name: "用户",
        desc: "",
        list: [
          {
            _id: 2,
            method: "POST",
            path: "/user/login",
            title: "登录",
          },
        ],
      },
    ];
    const result = parseImportedDoc("yapi", JSON.stringify(groups), TITLE);
    expect(result.paths["/health"].get).toBeDefined();
    expect(result.paths["/user/login"].post).toBeDefined();
    // summary 拼接了分组 name 作为 catname
    expect(result.paths["/health"].get!.summary).toBe("健康检查「公共分类」");
    expect(result.paths["/user/login"].post!.summary).toBe("登录「用户」");
  });

  it("数据导出格式但所有 list 为空 → 抛错", () => {
    const groups = [{ _id: 100, name: "空分类", list: [] }];
    expect(() => parseImportedDoc("yapi", JSON.stringify(groups), TITLE)).toThrow(/list 均为空/);
  });

  it("数据导出格式 list 含非对象 → 抛错", () => {
    const groups = [{ _id: 100, name: "x", list: [1, 2] }];
    expect(() => parseImportedDoc("yapi", JSON.stringify(groups), TITLE)).toThrow(/list 元素须为对象/);
  });

  it("非数组抛错", () => {
    const obj = { _id: 1, method: "GET", path: "/x" };
    expect(() => parseImportedDoc("yapi", JSON.stringify(obj), TITLE)).toThrow(/接口详情数组/);
  });

  it("空数组抛错", () => {
    expect(() => parseImportedDoc("yapi", "[]", TITLE)).toThrow(/数组为空/);
  });

  it("元素含非对象抛错", () => {
    expect(() => parseImportedDoc("yapi", "[1, 2]", TITLE)).toThrow(/元素须为对象/);
  });
});

describe("parseImportedDoc — 边界", () => {
  it("空内容抛错", () => {
    expect(() => parseImportedDoc("swagger", "", TITLE)).toThrow(/为空/);
    expect(() => parseImportedDoc("swagger", "   ", TITLE)).toThrow(/为空/);
  });
});
