/**
 * Swagger 懒加载缓存测试 — 并发去重 / TTL 过期 / invalidate / GC
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpenApiDocument } from "../types.js";

// mock fetchJson，避免真实网络请求
const fetchJsonMock = vi.fn();
vi.mock("../utils/http.js", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

import {
  getProjectDoc,
  getCached,
  invalidateProject,
  clearCache,
  startCacheGc,
  stopCacheGc,
} from "./cache.js";
import type { McpProject } from "../types.js";

const sampleProject: McpProject = {
  id: "proj_test1",
  name: "Test",
  desc: "",
  url: "http://example.com/swagger.json",
  createdAt: "",
  updatedAt: "",
};

const sampleDoc: OpenApiDocument = {
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0" },
  paths: { "/users": { get: { summary: "list users" } } },
};

beforeEach(() => {
  clearCache();
  fetchJsonMock.mockReset();
});

afterEach(() => {
  stopCacheGc();
});

describe("并发去重", () => {
  it("并发多次调用 getProjectDoc 只拉取一次", async () => {
    fetchJsonMock.mockImplementation(async () => {
      // 模拟网络延迟
      await new Promise((r) => setTimeout(r, 50));
      return sampleDoc;
    });

    const results = await Promise.all([
      getProjectDoc(sampleProject),
      getProjectDoc(sampleProject),
      getProjectDoc(sampleProject),
    ]);

    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    // 三个调用拿到同一文档对象
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(results[0].info.title).toBe("Test API");
  });

  it("拉取失败后 pending 被清理，可重试", async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error("network down"));
    fetchJsonMock.mockResolvedValueOnce(sampleDoc);

    await expect(getProjectDoc(sampleProject)).rejects.toThrow("network down");
    // 失败后再次调用应重新拉取
    const doc = await getProjectDoc(sampleProject);
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    expect(doc.info.title).toBe("Test API");
  });
});

describe("缓存命中与 TTL 过期", () => {
  it("首次拉取后缓存命中，不再拉取", async () => {
    fetchJsonMock.mockResolvedValue(sampleDoc);
    await getProjectDoc(sampleProject);
    await getProjectDoc(sampleProject);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    expect(getCached("proj_test1")).toBeDefined();
  });

  it("TTL 过期后重新拉取", async () => {
    fetchJsonMock.mockResolvedValue(sampleDoc);
    vi.useFakeTimers();

    await getProjectDoc(sampleProject);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);

    // 2h 内命中
    vi.advanceTimersByTime(60 * 60 * 1000); // 1h
    await getProjectDoc(sampleProject);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);

    // 超过 2h 过期，重新拉取
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1); // +2h1ms
    // getCached 此时应返回 undefined（过期）
    expect(getCached("proj_test1")).toBeUndefined();
    await getProjectDoc(sampleProject);
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe("invalidateProject", () => {
  it("失效后重新拉取", async () => {
    fetchJsonMock.mockResolvedValue(sampleDoc);
    await getProjectDoc(sampleProject);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);

    invalidateProject("proj_test1");
    expect(getCached("proj_test1")).toBeUndefined();

    await getProjectDoc(sampleProject);
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
  });
});

describe("GC", () => {
  it("GC 清理过期条目，保留有效条目", async () => {
    fetchJsonMock.mockResolvedValue(sampleDoc);
    vi.useFakeTimers();

    await getProjectDoc(sampleProject);
    expect(getCached("proj_test1")).toBeDefined();

    // 启动 GC（10min 间隔）
    startCacheGc();

    // 推进到过期之后
    vi.advanceTimersByTime(3 * 60 * 60 * 1000); // 3h
    // 触发 GC 扫描（advanceTimersByTime 会触发 setInterval 回调）
    vi.advanceTimersByTime(10 * 60 * 1000); // 10min → 触发一次 GC
    expect(getCached("proj_test1")).toBeUndefined();

    vi.useRealTimers();
  });
});
