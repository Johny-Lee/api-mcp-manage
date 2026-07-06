// @ts-ignore

/**
 * YApi → OpenApi 转换器测试（纯函数 convertYapiToOpenApi）
 *
 * 覆盖：query/header/path 参数、form/json/raw body、res_body json-schema 字符串、
 * HTML desc 清理、HTTP 方法映射、非法 method 跳过。
 */
import { describe, it, expect } from "vitest";
import { convertYapiToOpenApi } from "./yapi.js";

const baseDetail = {
  _id: 1,
  project_id: 10,
  catid: 100,
  method: "POST",
  path: "/user/login",
};

describe("convertYapiToOpenApi — 参数映射", () => {
  it("req_query → query 参数", () => {
    const doc = convertYapiToOpenApi([
      {
        ...baseDetail,
        title: "登录",
        method: "GET",
        path: "/user/list",
        req_query: [{ name: "page", desc: "页码", required: "1" }],
      },
    ], "Demo");
    const op = doc.paths["/user/list"].get;
    expect(op?.parameters).toBeDefined();
    expect(op!.parameters![0]).toMatchObject({ name: "page", in: "query", required: true });
  });

  it("req_headers → header 参数", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "t", method: "POST", path: "/x", req_headers: [{ name: "X-Trace", desc: "trace id", required: "0" }] },
    ], "Demo");
    expect(doc.paths["/x"].post!.parameters![0]).toMatchObject({ name: "X-Trace", in: "header", required: false });
  });

  it("req_params → path 参数（必填）", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "t", method: "GET", path: "/pet/{id}", req_params: [{ name: "id", desc: "宠物id" }] },
    ], "Demo");
    expect(doc.paths["/pet/{id}"].get!.parameters![0]).toMatchObject({ name: "id", in: "path", required: true });
  });
});

describe("convertYapiToOpenApi — requestBody", () => {
  it("req_body_type=form → x-www-form-urlencoded object schema", () => {
    const doc = convertYapiToOpenApi([
      {
        ...baseDetail, title: "t", method: "POST", path: "/upload",
        req_body_type: "form",
        req_body_form: [
          { name: "file", type: "file", required: "1", desc: "文件" },
          { name: "type", type: "text", required: "0", desc: "类型" },
        ],
      },
    ], "Demo");
    const rb = doc.paths["/upload"].post!.requestBody!;
    expect(rb.content["application/x-www-form-urlencoded"]).toBeDefined();
    const schema = rb.content["application/x-www-form-urlencoded"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>).file).toBeDefined();
    expect(schema.required).toEqual(["file"]);
  });

  it("req_body_type=json + req_body_other(schema) → application/json schema", () => {
    const doc = convertYapiToOpenApi([
      {
        ...baseDetail, title: "t", method: "POST", path: "/create",
        req_body_type: "json",
        req_body_other: JSON.stringify({ type: "object", properties: { name: { type: "string" } } }),
        req_body_is_json_schema: true,
      },
    ], "Demo");
    const rb = doc.paths["/create"].post!.requestBody!;
    const schema = rb.content["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>).name).toBeDefined();
  });

  it("req_body_type=raw → text/plain", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "t", method: "POST", path: "/raw", req_body_type: "raw", req_body_other: "plain text body" },
    ], "Demo");
    const rb = doc.paths["/raw"].post!.requestBody!;
    expect(rb.content["text/plain"]).toBeDefined();
  });
});

describe("convertYapiToOpenApi — res_body", () => {
  it("res_body json-schema 字符串 → 响应 schema", () => {
    const doc = convertYapiToOpenApi([
      {
        ...baseDetail, title: "t", method: "GET", path: "/info",
        res_body_type: "json",
        res_body: JSON.stringify({ type: "object", properties: { token: { type: "string" } } }),
        res_body_is_json_schema: true,
      },
    ], "Demo");
    const resp = doc.paths["/info"].get!.responses["200"];
    const schema = resp.content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>).token).toBeDefined();
  });

  it("res_body_is_json_schema=false 且 res_body 非 JSON 文本 → 降级为字符串描述 schema", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "t", method: "GET", path: "/raw", res_body_type: "json", res_body: "just text", res_body_is_json_schema: false },
    ], "Demo");
    const resp = doc.paths["/raw"].get!.responses["200"];
    // 非 JSON 文本 → 包成 string schema（不再丢弃）
    expect(resp.content).toBeDefined();
    const schema = resp.content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("string");
    expect(schema.description).toBe("just text");
  });

  it("res_body_is_json_schema 未设置 → 解析为具体响应示例（非 schema 形态时）", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "t", method: "GET", path: "/unset", res_body_type: "json", res_body: '{"a":1}' },
    ], "Demo");
    const content = doc.paths["/unset"].get!.responses["200"].content!;
    // 不是 schema 形态 → 视为具体响应示例：宽松 object schema + example
    expect(content).toBeDefined();
    const schema = content["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(content["application/json"].example).toEqual({ a: 1 });
  });

  it("res_body schema 解析失败 → 降级为 string 且保留完整原始文本", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "t", method: "GET", path: "/bad", res_body: "{not json", res_body_is_json_schema: true },
    ], "Demo");
    const schema = doc.paths["/bad"].get!.responses["200"].content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("string");
    // 不截断，保留完整原始文本
    expect(schema.description).toBe("{not json");
  });
});

describe("convertYapiToOpenApi — 边界", () => {
  it("非法 HTTP method 被跳过（不产生 path 条目）", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "t", method: "WEIRD", path: "/x" },
    ], "Demo");
    expect(doc.paths["/x"]).toBeUndefined();
  });

  it("HTML desc 被清理", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "t", method: "GET", path: "/x", desc: "<p>hello <b>world</b></p>" },
    ], "Demo");
    expect(doc.paths["/x"].get!.description).toBe("hello world");
  });

  it("空列表 → 空 paths", () => {
    const doc = convertYapiToOpenApi([], "Empty");
    expect(doc.paths).toEqual({});
    expect(doc.info.title).toBe("Empty");
  });

  it("同 path 多 method 共存", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "get", method: "GET", path: "/item" },
      { ...baseDetail, title: "del", method: "DELETE", path: "/item" },
    ], "Demo");
    expect(doc.paths["/item"].get).toBeDefined();
    expect(doc.paths["/item"].delete).toBeDefined();
  });
});

describe("convertYapiToOpenApi — summary 菜单名拼接", () => {
  it("有 catname 时 summary 为 接口名「菜单名」", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "登录", catname: "用户管理", method: "POST", path: "/user/login" },
    ], "Demo");
    expect(doc.paths["/user/login"].post!.summary).toBe("登录「用户管理」");
  });

  it("无 catname 时 summary 回退为接口名", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "登录", method: "POST", path: "/user/login" },
    ], "Demo");
    expect(doc.paths["/user/login"].post!.summary).toBe("登录");
  });

  it("catname 为空字符串时 summary 回退为接口名", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, title: "登录", catname: "", method: "POST", path: "/user/login" },
    ], "Demo");
    expect(doc.paths["/user/login"].post!.summary).toBe("登录");
  });

  it("多个不同菜单的接口各自拼接正确菜单名", () => {
    const doc = convertYapiToOpenApi([
      { ...baseDetail, _id: 1, title: "列表", catname: "用户", method: "GET", path: "/user/list" },
      { ...baseDetail, _id: 2, title: "列表", catname: "订单", method: "GET", path: "/order/list" },
    ], "Demo");
    expect(doc.paths["/user/list"].get!.summary).toBe("列表「用户」");
    expect(doc.paths["/order/list"].get!.summary).toBe("列表「订单」");
  });
});
