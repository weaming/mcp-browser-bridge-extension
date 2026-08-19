// MCP API 集成测试:以 mock 模式启动 host(BROWSER_BRIDGE_MOCK=1,
// 帧请求内部模拟应答),通过 HTTP 验证 MCP 协议与工具全链路。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let proc: ReturnType<typeof Bun.spawn>;
let sessionId: string | null = null;
let nextId = 1;

async function mcp(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: nextId++, method };
  if (params !== undefined) body.params = params;
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  expect(res.status).toBe(200);
  const text = await res.text();
  // SDK 按 Accept 返回 SSE 流;取首个 data 行解析
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", "host/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      BROWSER_BRIDGE_MOCK: "1",
      BROWSER_BRIDGE_PORT: String(PORT),
      BROWSER_BRIDGE_PORT_FILE: "/tmp/browser-bridge-test-port", // 不污染共享端口文件
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // 等待端口就绪
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE, { method: "POST", body: "{}" });
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
});

afterAll(() => {
  proc.kill();
});

describe("MCP protocol", () => {
  test("initialize 握手", async () => {
    const resp = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-api-test", version: "0.1.0" },
    });
    expect(resp).toHaveProperty("result");
    expect((resp.result as { serverInfo: { name: string } }).serverInfo.name).toBe("browser-bridge");
    expect(sessionId).toBeTruthy();
  });

  test("notifications/initialized 后 tools/list", async () => {
    expect(sessionId).toBeTruthy(); // 上一步 initialize 已建立会话

    const notif = await fetch(BASE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notif.status).toBeLessThan(400);

    const list = await mcp("tools/list");
    const tools = (list.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_click");
    expect(names).toContain("browser_type");
    expect(names).toContain("browser_goto");
    expect(names).toContain("browser_wait");
  });

  test("browser_snapshot 返回快照文本", async () => {
    const resp = await mcp("tools/call", { name: "browser_snapshot", arguments: {} });
    const content = (resp.result as { content: { type: string; text: string }[] }).content;
    const text = content.map((c) => c.text).join("\n");
    expect(text).toContain("Mock Page");
    expect(text).toContain("[1] <BUTTON> \"登录\"");
    expect(text).toContain("[2] <INPUT type=text> \"搜索\"");
  });

  test("browser_click 执行成功", async () => {
    const resp = await mcp("tools/call", { name: "browser_click", arguments: { ref: 1 } });
    const text = (resp.result as { content: { text: string }[] }).content[0].text;
    expect(text).toBe("ok");
  });

  test("非法参数被 SDK 校验拒绝", async () => {
    const resp = await mcp("tools/call", { name: "browser_click", arguments: {} });
    const result = resp.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("MCP error");
  });

  test("browser_goto 拒绝非 http url", async () => {
    const resp = await mcp("tools/call", { name: "browser_goto", arguments: { url: "javascript:x" } });
    const text = (resp.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("参数错误");
  });

  test("browser_list_tabs 返回标签页列表", async () => {
    const resp = await mcp("tools/call", { name: "browser_list_tabs", arguments: {} });
    const text = (resp.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("[1]");
    expect(text).toContain("Mock Page");
    expect(text).toContain("当前激活");
  });

  test("browser_use_tab 切换控制目标", async () => {
    const resp = await mcp("tools/call", { name: "browser_use_tab", arguments: { tabId: 2 } });
    const text = (resp.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("已切换目标");
  });

  test("browser_control_status 返回当前控制目标(跟随模式)", async () => {
    const resp = await mcp("tools/call", { name: "browser_control_status", arguments: {} });
    const text = (resp.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("跟随模式");
    expect(text).toContain("Mock Page");
  });

  test("browser_new_tab 新建标签页", async () => {
    const resp = await mcp("tools/call", { name: "browser_new_tab", arguments: { url: "https://example.com" } });
    const text = (resp.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("已打开新标签页");
    expect(text).toContain("example.com");
  });

  test("browser_close_tab 关闭标签页", async () => {
    const resp = await mcp("tools/call", { name: "browser_close_tab", arguments: {} });
    const text = (resp.result as { content: { text: string }[] }).content[0].text;
    expect(text).toBe("已关闭");
  });
});
