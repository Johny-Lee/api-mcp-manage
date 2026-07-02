import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpProjectsConfig, OpenApiOperation, OpenApiParameter } from "../types.js";
import type { OpenApiDocumentLike } from "../swagger/types-helpers.js";
import { getProjectDoc, invalidateProject } from "../swagger/cache.js";
import { dereferenceNode } from "../swagger/dereference.js";
import {
  formatApiList,
  filterApiList,
  formatApiDetail,
  formatNotFound,
} from "../swagger/format.js";
import { logger } from "../utils/logger.js";

/**
 * 注册三个只读 MCP 工具
 *
 * 严格只读边界：所有工具仅读取与格式化，绝不执行/修改/发包。
 *
 * @param server MCP Server 实例
 * @param getConfig 获取当前配置（动态读取，支持热更新）
 */
export function registerTools(
  server: McpServer,
  getConfig: () => McpProjectsConfig,
): void {
  // ────────────────────────────────────────────
  // Tool 1: list_projects（项目大盘）→ JSON
  // ────────────────────────────────────────────
  server.registerTool(
    "list_projects",
    {
      title: "API 项目大盘",
      description: "获取当前系统配置的所有 API 项目列表及各自功能描述，用于判断目标接口归属哪一个子系统。",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const config = getConfig();
      const list = config.projects.map((p) => ({
        id: p.id,
        name: p.name,
        desc: p.desc,
      }));
      return {
        content: [
          { type: "text", text: JSON.stringify(list, null, 2) },
        ],
      };
    },
  );

  // ────────────────────────────────────────────
  // Tool 2: get_api_list（路由列表）→ Markdown
  // ────────────────────────────────────────────
  server.registerTool(
    "get_api_list",
    {
      title: "接口路由列表",
      description: "获取特定项目下的精简接口列表概要（首次调用时自动触发该项目的懒加载机制）。",
      inputSchema: {
        projectId: z.string().describe("目标项目 ID"),
        keyword: z.string().optional().describe("模糊搜索路径或接口名称的关键词"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, keyword }) => {
      const config = getConfig();
      const project = config.projects.find((p) => p.id === projectId);
      if (!project) {
        return errorMarkdown(`项目不存在: ${projectId}\n请使用 list_projects 查看可用项目。`);
      }
      try {
        const doc = await getProjectDoc(project);
        const filtered = filterApiList(doc, keyword);
        const markdown = formatApiList(project.name, project.id, filtered);
        return { content: [{ type: "text", text: markdown }] };
      } catch (err) {
        logger.error("get_api_list 失败", { projectId, error: String(err) });
        // 缓存可能因失败状态残留，主动失效以便下次重试
        invalidateProject(projectId);
        return errorMarkdown(
          `拉取项目 **${project.name}** 的接口列表失败：${errMsg(err)}\n请稍后重试或检查项目 URL 与 Token 配置。`,
        );
      }
    },
  );

  // ────────────────────────────────────────────
  // Tool 3: get_api_details（接口详情）→ Markdown（局部 $ref 解引用）
  // ────────────────────────────────────────────
  server.registerTool(
    "get_api_details",
    {
      title: "接口详情",
      description: "获取特定项目下某接口的请求参数、Header 及响应体详细结构定义。解析时仅对该节点进行局部 $ref 解引用。",
      inputSchema: {
        projectId: z.string().describe("目标项目 ID"),
        path: z.string().describe("接口路由路径，如 /api/v1/login"),
        method: z.string().describe("HTTP 方法，如 GET/POST"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, path, method }) => {
      const config = getConfig();
      const project = config.projects.find((p) => p.id === projectId);
      if (!project) {
        return errorMarkdown(`项目不存在: ${projectId}\n请使用 list_projects 查看可用项目。`);
      }
      const methodLower = method.toLowerCase();
      try {
        const doc = await getProjectDoc(project);
        const pathItem = doc.paths[path];
        if (!pathItem) {
          return { content: [{ type: "text", text: formatNotFound(project.name, path, method) }] };
        }
        const op = pathItem[methodLower] as OpenApiOperation | undefined;
        if (!op) {
          return { content: [{ type: "text", text: formatNotFound(project.name, path, method) }] };
        }

        // 局部 $ref 解引用：以完整文档为根，对 operation 内 schema 节点递归解析
        const derefedOp = derefOperation(op, doc as unknown as OpenApiDocumentLike);

        const markdown = formatApiDetail(project.name, path, methodLower, derefedOp);
        return { content: [{ type: "text", text: markdown }] };
      } catch (err) {
        logger.error("get_api_details 失败", { projectId, path, method, error: String(err) });
        invalidateProject(projectId);
        return errorMarkdown(
          `获取接口详情失败：${errMsg(err)}\n请稍后重试或检查项目配置。`,
        );
      }
    },
  );
}

/** 对 operation 内的 schema 节点做局部解引用（导出供测试） */
export function derefOperation(
  op: OpenApiOperation,
  doc: OpenApiDocumentLike,
): OpenApiOperation {
  const out: OpenApiOperation = { ...op };

  // 解引用 parameters（参数本身可能是 $ref，或其 schema 含 $ref）
  if (op.parameters && op.parameters.length) {
    out.parameters = op.parameters.map((p) => {
      const derefedParam = dereferenceNode(p as unknown as Record<string, unknown>, doc) as unknown as OpenApiParameter;
      // 若 parameter.schema 仍含 $ref（解引用未命中目标），进一步尝试
      if (derefedParam.schema) {
        derefedParam.schema = dereferenceNode(derefedParam.schema as Record<string, unknown>, doc);
      }
      return derefedParam;
    });
  }

  // 解引用 requestBody schemas
  if (op.requestBody?.content) {
    out.requestBody = { ...op.requestBody, content: {} };
    for (const [ct, media] of Object.entries(op.requestBody.content)) {
      const schema = media.schema ? dereferenceNode(media.schema as Record<string, unknown>, doc) : undefined;
      out.requestBody.content![ct] = { ...media, schema: schema as Record<string, unknown> | undefined };
    }
  }

  // 解引用 response schemas
  if (op.responses) {
    out.responses = {};
    for (const [code, resp] of Object.entries(op.responses)) {
      const newResp = { ...resp };
      if (resp.content) {
        newResp.content = {};
        for (const [ct, media] of Object.entries(resp.content)) {
          const schema = media.schema ? dereferenceNode(media.schema as Record<string, unknown>, doc) : undefined;
          newResp.content[ct] = { ...media, schema: schema as Record<string, unknown> | undefined };
        }
      }
      out.responses[code] = newResp;
    }
  }

  return out;
}

/** 构造错误 Markdown 返回 */
function errorMarkdown(message: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: `### ❌ 错误\n\n${message}` }] };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
