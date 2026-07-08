/**
 * Postman Collection 导入转换测试
 *
 * 覆盖：嵌套 folder/request、url 字符串/对象提取路径、raw json 请求体、
 *   urlencoded/formdata 表单、query/header 参数、响应转换（示例）、
 *   缺 item 报错、非法格式报错。
 */
import { describe, it, expect } from "vitest";
import { parseImportedDoc } from "./import.js";
import { convertPostmanToOpenApi, isPostmanCollection } from "./postman.js";
import type { PostmanCollection } from "./postman.js";

const TITLE = "Demo";

/**
 * 构造一个最小 Postman Collection v2.1 导出（含嵌套文件夹 + 多种 body 模式）
 *
 * 结构：
 *   根 → 用户(文件夹) → [用户列表(GET+query), 创建用户(POST+raw json)]
 *      → 文件上传(文件夹) → [上传(POST+formdata)]
 */
function postmanCollection(): PostmanCollection {
  return {
    info: {
      name: "测试集合",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "用户",
        item: [
          {
            name: "用户列表",
            request: {
              method: "GET",
              // url 为对象：含 path + query
              url: {
                raw: "https://api.example.com/api/user/list?page=1",
                path: ["api", "user", "list"],
                query: [{ key: "page", value: "1", description: "页码" }],
              },
              header: [{ key: "X-Trace", value: "abc", description: "trace id" }],
            },
            response: [
              {
                name: "成功",
                code: 200,
                status: "OK",
                body: JSON.stringify({ code: 0, data: [] }),
              },
            ],
          },
          {
            name: "创建用户",
            request: {
              method: "POST",
              // url 为字符串
              url: "https://api.example.com/api/user/create",
              body: {
                mode: "raw",
                raw: JSON.stringify({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
                options: { raw: { language: "json" } },
              },
            },
            response: [
              { name: "成功", code: 200, body: JSON.stringify({ id: 1 }) },
            ],
          },
        ],
      },
      {
        name: "文件上传",
        item: [
          {
            name: "上传文件",
            request: {
              method: "POST",
              url: "{{host}}/upload",
              body: {
                mode: "formdata",
                formdata: [
                  { key: "file", type: "file", description: "文件" },
                  { key: "type", value: "image", description: "类型" },
                ],
              },
            },
            response: [{ name: "成功", code: 200 }],
          },
        ],
      },
    ],
  };
}

describe("isPostmanCollection", () => {
  it("含 item 数组 → true", () => {
    expect(isPostmanCollection({ info: {}, item: [] })).toBe(true);
  });

  it("缺 item → false", () => {
    expect(isPostmanCollection({ info: {} })).toBe(false);
  });

  it("item 非数组 → false", () => {
    expect(isPostmanCollection({ item: {} })).toBe(false);
  });

  it("非对象 → false", () => {
    expect(isPostmanCollection([])).toBe(false);
    expect(isPostmanCollection(null)).toBe(false);
  });
});

describe("convertPostmanToOpenApi", () => {
  it("嵌套文件夹中的 request 全部提取", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    expect(Object.keys(doc.paths)).toContain("/api/user/list");
    expect(Object.keys(doc.paths)).toContain("/api/user/create");
    expect(Object.keys(doc.paths)).toContain("/upload");
  });

  it("url 为对象时从 path 数组提取路径", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    expect(doc.paths["/api/user/list"]).toBeDefined();
    expect(doc.paths["/api/user/list"].get).toBeDefined();
  });

  it("url 为字符串时去掉协议与主机", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    // https://api.example.com/api/user/create → /api/user/create
    expect(doc.paths["/api/user/create"]).toBeDefined();
  });

  it("url 含变量占位符（{{host}}）时提取其后路径", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    expect(doc.paths["/upload"]).toBeDefined();
  });

  it("query/header 参数转换", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    const op = doc.paths["/api/user/list"].get!;
    expect(op.parameters).toBeDefined();
    const queryParam = op.parameters!.find((p) => p.in === "query")!;
    expect(queryParam.name).toBe("page");
    expect(queryParam.description).toBe("页码");
    const headerParam = op.parameters!.find((p) => p.in === "header")!;
    expect(headerParam.name).toBe("X-Trace");
  });

  it("raw json 请求体（形如 schema）→ application/json schema", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    const op = doc.paths["/api/user/create"].post!;
    expect(op.requestBody).toBeDefined();
    const ct = op.requestBody!.content!["application/json"];
    expect(ct).toBeDefined();
    const schema = ct.schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });

  it("formdata 请求体 → multipart/form-data", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    const op = doc.paths["/upload"].post!;
    expect(op.requestBody).toBeDefined();
    const ct = op.requestBody!.content!["multipart/form-data"];
    expect(ct).toBeDefined();
    const schema = ct.schema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.file).toBeDefined();
    expect(props.type).toBeDefined();
  });

  it("响应体（JSON 字符串）→ 解析为 example", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    const op = doc.paths["/api/user/list"].get!;
    expect(op.responses!["200"]).toBeDefined();
    const ct = op.responses!["200"].content!["application/json"];
    expect(ct.example).toEqual({ code: 0, data: [] });
  });

  it("无 body 的请求 → 无 requestBody", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    expect(doc.paths["/api/user/list"].get!.requestBody).toBeUndefined();
  });

  it("summary 取自节点 name", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    expect(doc.paths["/api/user/list"].get!.summary).toBe("用户列表");
  });

  it("标题取自 info.name", () => {
    const doc = convertPostmanToOpenApi(postmanCollection(), TITLE);
    expect(doc.info.title).toBe("测试集合");
  });

  it("无 info.name 时回退到传入 title", () => {
    const col = postmanCollection();
    delete col.info;
    const doc = convertPostmanToOpenApi(col, TITLE);
    expect(doc.info.title).toBe(TITLE);
  });

  it("空 item → 无 paths", () => {
    const doc = convertPostmanToOpenApi({ info: { name: "x" }, item: [] }, TITLE);
    expect(Object.keys(doc.paths)).toHaveLength(0);
  });

  it("raw 非 JSON 文本 → text/plain", () => {
    const col: PostmanCollection = {
      info: { name: "x" },
      item: [
        {
          name: "原始文本",
          request: {
            method: "POST",
            url: "/raw",
            body: { mode: "raw", raw: "hello world" },
          },
          response: [],
        },
      ],
    };
    const doc = convertPostmanToOpenApi(col, TITLE);
    const op = doc.paths["/raw"].post!;
    expect(op.requestBody!.content!["text/plain"]).toBeDefined();
  });

  it("urlencoded 请求体 → application/x-www-form-urlencoded", () => {
    const col: PostmanCollection = {
      info: { name: "x" },
      item: [
        {
          name: "表单",
          request: {
            method: "POST",
            url: "/form",
            body: {
              mode: "urlencoded",
              urlencoded: [
                { key: "name", value: "test" },
                { key: "age", value: "18" },
              ],
            },
          },
          response: [],
        },
      ],
    };
    const doc = convertPostmanToOpenApi(col, TITLE);
    const op = doc.paths["/form"].post!;
    expect(op.requestBody!.content!["application/x-www-form-urlencoded"]).toBeDefined();
  });

  it("request 为字符串简写形式 → 按 GET 解析", () => {
    const col: PostmanCollection = {
      info: { name: "x" },
      item: [{ name: "简写", request: "/simple" }],
    };
    const doc = convertPostmanToOpenApi(col, TITLE);
    expect(doc.paths["/simple"]).toBeDefined();
    expect(doc.paths["/simple"].get).toBeDefined();
  });
});

describe("parseImportedDoc - postman 源", () => {
  it("合法导出格式校验通过", () => {
    const result = parseImportedDoc("postman", JSON.stringify(postmanCollection()), TITLE);
    expect(result.openapi).toBe("3.0.0");
    expect(Object.keys(result.paths).length).toBeGreaterThan(0);
  });

  it("非对象（数组）抛错", () => {
    expect(() => parseImportedDoc("postman", "[]", TITLE)).toThrow(/JSON 对象/);
  });

  it("缺少 item 字段抛错", () => {
    expect(() => parseImportedDoc("postman", JSON.stringify({ info: { name: "x" } }), TITLE)).toThrow(/item/);
  });

  it("JSON 解析失败抛错", () => {
    expect(() => parseImportedDoc("postman", "{invalid", TITLE)).toThrow(/JSON 解析失败/);
  });

  it("空内容抛错", () => {
    expect(() => parseImportedDoc("postman", "", TITLE)).toThrow(/为空/);
  });
});
