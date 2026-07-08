/**
 * Apifox 测试
 *
 * 导入转换：apiCollection 嵌套文件夹/api、query/header/path 参数、json/form 请求体、
 *   响应转换（jsonSchema 对象）、路径规范化、缺 apiCollection 报错、非法格式报错。
 * 自动拉取：buildApifoxExportRequest 的 URL/body 构造、baseUrl 默认值/自定义、
 *   extractApifoxEnvs 从 servers 提取环境域名。
 */
import { describe, it, expect } from "vitest";
import { parseImportedDoc } from "./import.js";
import { convertApifoxToOpenApi, buildApifoxExportRequest, extractApifoxEnvs, APIFOX_DEFAULT_BASE_URL } from "./apifox.js";
import type { ApifoxExport, ApifoxExportBody } from "./apifox.js";
import type { McpProject, OpenApiDocument } from "../types.js";

const TITLE = "Demo";

/**
 * 构造一个最小 Apifox 导出（按真实导出格式：apiCollection + api 节点 + jsonSchema 对象）
 *
 * 结构：根目录 → 用户接口(文件夹) → [用户列表, 创建用户] + 文件上传(文件夹) → [上传文件]
 */
function apifoxExport(): ApifoxExport {
  return {
    apifoxProject: "测试项目",
    info: { name: "测试项目" },
    apiCollection: [
      {
        name: "根目录",
        items: [
          {
            name: "用户接口",
            items: [
              {
                name: "用户列表",
                api: {
                  method: "get",
                  path: "/api/user/list",
                  parameters: {
                    query: [{ name: "page", type: "integer", required: true, description: "页码" }],
                    header: [{ name: "X-Trace", type: "string", required: false, description: "trace id" }],
                  },
                  responses: [
                    {
                      name: "成功",
                      code: 200,
                      contentType: "json",
                      jsonSchema: { type: "object", properties: { code: { type: "integer" } } },
                    },
                  ],
                },
              },
              {
                name: "创建用户",
                api: {
                  method: "post",
                  path: "api/user/create",
                  requestBody: {
                    type: "json",
                    jsonSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
                  },
                  responses: [
                    {
                      name: "成功",
                      code: 200,
                      contentType: "json",
                      jsonSchema: { type: "object", properties: { id: { type: "integer" } } },
                    },
                  ],
                },
              },
            ],
          },
          {
            name: "文件上传",
            items: [
              {
                name: "上传文件",
                api: {
                  method: "post",
                  path: "/upload",
                  requestBody: {
                    type: "multipart/form-data",
                    parameters: [
                      { name: "file", type: "file", required: true, description: "文件" },
                      { name: "type", type: "string", required: false, description: "类型" },
                    ],
                  },
                  responses: [{ name: "成功", code: 200, contentType: "json", jsonSchema: { type: "object" } }],
                },
              },
              {
                name: "原始文本",
                api: {
                  method: "post",
                  path: "/raw",
                  requestBody: { type: "raw", raw: "hello world" },
                  responses: [{ name: "成功", code: 200 }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("convertApifoxToOpenApi", () => {
  it("嵌套文件夹中的 api 全部提取", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    expect(Object.keys(doc.paths)).toContain("/api/user/list");
    expect(Object.keys(doc.paths)).toContain("/api/user/create");
    expect(Object.keys(doc.paths)).toContain("/upload");
    expect(Object.keys(doc.paths)).toContain("/raw");
  });

  it("query/header 参数转换", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    const op = doc.paths["/api/user/list"].get!;
    expect(op.parameters).toBeDefined();
    const queryParam = op.parameters!.find((p) => p.in === "query")!;
    expect(queryParam.name).toBe("page");
    expect(queryParam.required).toBe(true);
    const headerParam = op.parameters!.find((p) => p.in === "header")!;
    expect(headerParam.name).toBe("X-Trace");
    expect(headerParam.required).toBe(false);
  });

  it("json 请求体转换（jsonSchema 对象）", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    const op = doc.paths["/api/user/create"].post!;
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody!.content!["application/json"]).toBeDefined();
    const schema = op.requestBody!.content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });

  it("multipart/form-data 请求体转换", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    const op = doc.paths["/upload"].post!;
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody!.content!["multipart/form-data"]).toBeDefined();
    const schema = op.requestBody!.content!["multipart/form-data"].schema as Record<string, unknown>;
    expect((schema.required as string[])).toContain("file");
  });

  it("raw 请求体转换", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    const op = doc.paths["/raw"].post!;
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody!.content!["text/plain"]).toBeDefined();
  });

  it("none 请求体 → 无 requestBody", () => {
    const exp = apifoxExport();
    // 用户列表本无 requestBody（type 默认 none）
    const doc = convertApifoxToOpenApi(exp, TITLE);
    expect(doc.paths["/api/user/list"].get!.requestBody).toBeUndefined();
  });

  it("响应转换：jsonSchema 对象 → content schema", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    const op = doc.paths["/api/user/list"].get!;
    expect(op.responses!["200"]).toBeDefined();
    expect(op.responses!["200"].content!["application/json"]).toBeDefined();
    const schema = op.responses!["200"].content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });

  it("路径缺少前导斜杠时自动补全", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    expect(doc.paths["/api/user/create"]).toBeDefined();
  });

  it("summary 取自节点 name", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    expect(doc.paths["/api/user/list"].get!.summary).toBe("用户列表");
  });

  it("标题优先级：info.name > apifoxProject", () => {
    const doc = convertApifoxToOpenApi(apifoxExport(), TITLE);
    // info.name 与 apifoxProject 同为「测试项目」
    expect(doc.info.title).toBe("测试项目");
  });

  it("无 info.name 时回退到 apifoxProject", () => {
    const exp = apifoxExport();
    delete exp.info;
    const doc = convertApifoxToOpenApi(exp, TITLE);
    expect(doc.info.title).toBe("测试项目");
  });

  it("info.name 优先于 apifoxProject（真实导出中 apifoxProject 可能是版本号）", () => {
    const exp = apifoxExport();
    exp.apifoxProject = "1.0.0"; // 真实导出里 apifoxProject 常为版本号
    exp.info = { name: "api" };
    const doc = convertApifoxToOpenApi(exp, TITLE);
    expect(doc.info.title).toBe("api");
  });

  it("无 info.name 与 apifoxProject 时回退到传入 title", () => {
    const exp = apifoxExport();
    delete exp.apifoxProject;
    delete exp.info;
    const doc = convertApifoxToOpenApi(exp, TITLE);
    expect(doc.info.title).toBe(TITLE);
  });

  it("空 apiCollection -> 无 paths", () => {
    const doc = convertApifoxToOpenApi({ apiCollection: [] }, TITLE);
    expect(Object.keys(doc.paths)).toHaveLength(0);
  });

  it("兼容旧版 collection 字段", () => {
    const exp = apifoxExport();
    // 把 apiCollection 改名为 collection，应同样能解析
    exp.collection = exp.apiCollection;
    delete exp.apiCollection;
    const doc = convertApifoxToOpenApi(exp, TITLE);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });
});

describe("parseImportedDoc - apifox 源", () => {
  it("合法导出格式校验通过", () => {
    const result = parseImportedDoc("apifox", JSON.stringify(apifoxExport()), TITLE);
    expect(result.openapi).toBe("3.0.0");
    expect(Object.keys(result.paths).length).toBeGreaterThan(0);
  });

  it("非对象（数组）抛错", () => {
    expect(() => parseImportedDoc("apifox", "[]", TITLE)).toThrow(/JSON 对象/);
  });

  it("缺少 apiCollection 字段抛错", () => {
    expect(() => parseImportedDoc("apifox", JSON.stringify({ apifoxProject: "x" }), TITLE)).toThrow(/apiCollection/);
  });

  it("JSON 解析失败抛错", () => {
    expect(() => parseImportedDoc("apifox", "{invalid", TITLE)).toThrow(/JSON 解析失败/);
  });

  it("空内容抛错", () => {
    expect(() => parseImportedDoc("apifox", "", TITLE)).toThrow(/为空/);
  });
});

// ──────────────────────────────────────────────
// 自动拉取：buildApifoxExportRequest（纯函数，无网络）
// ──────────────────────────────────────────────

/** 构造一个 source=apifox 的项目配置 */
function apifoxProject(overrides: Partial<McpProject> = {}): McpProject {
  return {
    id: "proj_test",
    name: "测试",
    desc: "",
    source: "apifox",
    projectId: "123456",
    token: "test-token-abc",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildApifoxExportRequest", () => {
  it("baseUrl 缺省时使用公有云默认值", () => {
    const { url } = buildApifoxExportRequest(apifoxProject({ baseUrl: undefined }));
    expect(url).toBe(`${APIFOX_DEFAULT_BASE_URL}/v1/projects/123456/export-openapi`);
  });

  it("自定义 baseUrl 生效", () => {
    const { url } = buildApifoxExportRequest(apifoxProject({ baseUrl: "https://apifox.internal.com" }));
    expect(url).toBe("https://apifox.internal.com/v1/projects/123456/export-openapi");
  });

  it("baseUrl 尾部斜杠被去除", () => {
    const { url } = buildApifoxExportRequest(apifoxProject({ baseUrl: "https://api.apifox.com//" }));
    expect(url).toBe("https://api.apifox.com/v1/projects/123456/export-openapi");
  });

  it("body 结构：scope.type=ALL, oasVersion=3.0, exportFormat=JSON", () => {
    const { body } = buildApifoxExportRequest(apifoxProject());
    const expected: ApifoxExportBody = {
      scope: { type: "ALL" },
      oasVersion: "3.0",
      exportFormat: "JSON",
      options: {
        includeApifoxExtensionProperties: false,
        addFoldersToTags: false,
      },
    };
    expect(body).toEqual(expected);
  });

  it("projectId 缺省时仍可构造 url（路径段为空，实际拉取会报错）", () => {
    const { url } = buildApifoxExportRequest(apifoxProject({ projectId: undefined }));
    expect(url).toBe(`${APIFOX_DEFAULT_BASE_URL}/v1/projects//export-openapi`);
  });
});

// ──────────────────────────────────────────────
// extractApifoxEnvs（从 OpenAPI servers 提取环境域名）
// ──────────────────────────────────────────────

describe("extractApifoxEnvs", () => {
  function docWith(servers: unknown): OpenApiDocument {
    return { openapi: "3.0.0", info: { title: "x" }, paths: {}, ...(servers ? { servers } : {}) } as OpenApiDocument;
  }

  it("servers 含 description → 用 description 作 name", () => {
    const envs = extractApifoxEnvs(docWith([
      { url: "https://api.example.com", description: "生产环境" },
    ]));
    expect(envs).toHaveLength(1);
    expect(envs![0]).toEqual({ name: "生产环境", domain: "https://api.example.com" });
  });

  it("servers 无 description → 用 url 作 name", () => {
    const envs = extractApifoxEnvs(docWith([{ url: "https://api.example.com" }]));
    expect(envs![0].name).toBe("https://api.example.com");
    expect(envs![0].domain).toBe("https://api.example.com");
  });

  it("多个 servers 全部提取", () => {
    const envs = extractApifoxEnvs(docWith([
      { url: "https://prod.example.com", description: "生产" },
      { url: "https://dev.example.com", description: "开发" },
    ]));
    expect(envs).toHaveLength(2);
  });

  it("无 servers 字段 → undefined", () => {
    expect(extractApifoxEnvs(docWith(undefined))).toBeUndefined();
  });

  it("servers 为空数组 → undefined", () => {
    expect(extractApifoxEnvs(docWith([]))).toBeUndefined();
  });

  it("servers 元素缺 url → 被跳过", () => {
    const envs = extractApifoxEnvs(docWith([
      { description: "无url" },
      { url: "https://ok.example.com" },
    ]));
    expect(envs).toHaveLength(1);
    expect(envs![0].domain).toBe("https://ok.example.com");
  });
});
