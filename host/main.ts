// browser-bridge host:唯一进程,两个角色:
// 1. native messaging host(stdin/stdout 帧协议)—— 与 Chrome 扩展通信
// 2. MCP server(Streamable HTTP,127.0.0.1:8790)—— 对 AI/程序暴露浏览器控制工具
// 工具调用 → 帧请求 → 扩展执行 → 结果转 MCP 响应。
// BROWSER_BRIDGE_MOCK=1 时帧请求由内部模拟应答(无扩展也能测 MCP API)。

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { encodeFrame, FrameReader } from "./native-protocol";
import { actionFromArgs, PRESS_KEYS, SCROLL_DIRS, BUTTONS, MODIFIERS } from "../shared/actions";
import type { NativeRequest, NativeResponse, Snapshot } from "../shared/messages";

const START_PORT = Number(process.env.BROWSER_BRIDGE_PORT ?? 1234);
// 端口文件路径可覆盖(测试/多实例场景避免互相污染)
const PORT_FILE = process.env.BROWSER_BRIDGE_PORT_FILE ?? join(homedir(), ".browser-bridge", "port");
const MOCK = process.env.BROWSER_BRIDGE_MOCK === "1";
let port = START_PORT; // 实际监听端口,由下方端口探测决定

// ---------- native messaging 层(与扩展通信) ----------

const writer = Bun.stdout.writer();
let seq = 0;

interface Pending {
  resolve: (m: NativeResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, Pending>();

type FrameRequest = Extract<NativeRequest, { seq: number }>;

function sendToExtension(msg: FrameRequest, timeoutMs = 10_000): Promise<NativeResponse> {
  if (MOCK) return mockRespond(msg);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(msg.seq);
      reject(new Error("扩展无响应(超时)"));
    }, timeoutMs);
    pending.set(msg.seq, { resolve, reject, timer });
    writer.write(encodeFrame(msg));
    writer.flush();
  });
}

// mock 模式:模拟扩展的应答,便于无 Chrome 测试 MCP API
function mockRespond(msg: FrameRequest): Promise<NativeResponse> {
  const snap: Snapshot = {
    url: "https://example.com/mock",
    title: "Mock Page",
    ts: 0,
    scroll: { x: 0, y: 0, vh: 800, vw: 1200 },
    nodes: [
      { ref: 1, tag: "BUTTON", text: "登录", visible: true, rect: { x: 10, y: 10, w: 80, h: 32 } },
      { ref: 2, tag: "INPUT", type: "text", text: "搜索", visible: true, rect: { x: 10, y: 50, w: 200, h: 30 } },
    ],
    truncated: false,
  };
  if (msg.t === "snapshot") {
    return Promise.resolve({ t: "snapshot", seq: msg.seq, url: snap.url, title: snap.title, snapshot: snap });
  }
  if (msg.t === "list-tabs") {
    return Promise.resolve({
      t: "tabs",
      seq: msg.seq,
      tabs: [
        { id: 1, title: "Mock Page", url: "https://example.com/mock", active: true },
        { id: 2, title: "另一个标签", url: "https://example.org", active: false },
      ],
    });
  }
  if (msg.t === "set-target") {
    return Promise.resolve({ t: "set-target-result", seq: msg.seq, ok: true, message: "Mock Page" });
  }
  if (msg.t === "get-target") {
    return Promise.resolve({
      t: "target-info",
      seq: msg.seq,
      target: { tabId: 1, title: "Mock Page", url: "https://example.com/mock" },
      connected: true,
      mode: "follow",
    });
  }
  if (msg.t === "get-port") {
    return Promise.resolve({ t: "port-info", seq: msg.seq, port: START_PORT });
  }
  if (msg.t === "new-tab") {
    return Promise.resolve({
      t: "new-tab-result",
      seq: msg.seq,
      ok: true,
      tabId: 99,
      title: "New Mock Tab",
      url: msg.url ?? "",
    });
  }
  if (msg.t === "close-tab") {
    return Promise.resolve({ t: "close-tab-result", seq: msg.seq, ok: true });
  }
  if (msg.t === "activate-tab") {
    return Promise.resolve({ t: "activate-tab-result", seq: msg.seq, ok: true });
  }
  if (msg.t === "duplicate-tab") {
    return Promise.resolve({ t: "duplicate-tab-result", seq: msg.seq, ok: true, tabId: 100 });
  }
  if (msg.t === "pin-tab") {
    return Promise.resolve({ t: "pin-tab-result", seq: msg.seq, ok: true });
  }
  if (msg.t === "screenshot") {
    return Promise.resolve({
      t: "screenshot-result",
      seq: msg.seq,
      ok: true,
      dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", // mock 极小图片
    });
  }
  return Promise.resolve({ t: "execute-result", seq: msg.seq, ok: true });
}

(async () => {
  if (MOCK) return;
  const reader = new FrameReader(process.stdin);
  try {
    for await (const frame of reader.frames()) {
      // 单帧解析/处理错误不影响后续帧
      try {
        // 扩展回的是 NativeResponse;ping/get-port 是扩展发起的查询
        const msg = JSON.parse(frame.subarray(4).toString("utf8")) as
          | NativeResponse
          | { t: "ping" }
          | { t: "get-port"; seq: number };
        if (msg.t === "ping") {
          writer.write(encodeFrame({ t: "pong" }));
          writer.flush();
          continue;
        }
        if (msg.t === "get-port") {
          writer.write(encodeFrame({ t: "port-info", seq: msg.seq, port }));
          writer.flush();
          continue;
        }
        if ("seq" in msg && pending.has(msg.seq)) {
          const w = pending.get(msg.seq)!;
          pending.delete(msg.seq);
          clearTimeout(w.timer);
          if (msg.t === "error") w.reject(new Error(msg.message));
          else w.resolve(msg);
        } else if (msg.t === "error") {
          console.error(`extension error: ${msg.message}`);
        }
      } catch (err) {
        console.error(`bad frame skipped: ${String(err)}`);
      }
    }
  } catch (err) {
    console.error(`native stream error: ${String(err)}`);
  }
  // stdin EOF:扩展断开,拒绝所有未决请求;延迟退出防僵尸(Chrome 正常会 SIGTERM)
  for (const [, w] of pending) {
    clearTimeout(w.timer);
    w.reject(new Error("扩展已断开"));
  }
  pending.clear();
  console.error("native messaging channel closed, exiting in 30s if not killed");
  setTimeout(() => process.exit(0), 30_000).unref?.();
})();

// ---------- 工具实现 ----------

function snapshotText(s: Snapshot): string {
  const lines = [`URL: ${s.url}`, `标题: ${s.title}`];
  for (const n of s.nodes) {
    let line = `[${n.ref}] <${n.tag}`;
    if (n.type) line += ` type=${n.type}`;
    line += ">";
    if (n.text) line += ` "${n.text}"`;
    if (n.href) line += ` href=${n.href}`;
    if (n.name) line += ` name=${n.name}`;
    if (n.value) line += ` value="${n.value}"`;
    if (n.checked) line += " checked";
    if (n.disabled) line += " disabled";
    if (n.rect) line += ` @(${n.rect.x},${n.rect.y} ${n.rect.w}x${n.rect.h})`;
    if (!n.visible) line += " (视口外)";
    if (n.opts?.length) line += ` 选项:${n.opts.join("|")}`;
    lines.push(line);
  }
  if (s.truncated) lines.push("(节点过多已截断,只显示前部分)");
  return lines.join("\n");
}

// 工具注册表:SDK(会话模式)与无状态模式共用同一套定义与实现
interface ToolDef {
  description: string;
  schema: z.ZodRawShape; // 普通对象 shape,SDK tool() 原生支持
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const TOOLS = new Map<string, ToolDef>();

function tool(
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (args: Record<string, unknown>) => Promise<string>,
): void {
  TOOLS.set(name, { description, schema, handler });
}

async function executeAction(kind: Parameters<typeof actionFromArgs>[0], args: Record<string, unknown>): Promise<string> {
  const action = actionFromArgs(kind, args);
  if (!("action" in action)) return `参数错误: ${action.error}`;
  const resp = await sendToExtension({ t: "execute", seq: ++seq, action });
  if (resp.t === "execute-result") {
    if (resp.ok) return "ok";
    return `失败: ${resp.code ?? "unknown"}${resp.detail ? ` — ${resp.detail}` : ""}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
}

// ---------- MCP 工具定义(注册到 TOOLS 表) ----------

tool("browser_snapshot", "获取当前受控页面的可交互元素快照(带 ref 编号与坐标),AI 据此决定后续操作", {}, async () => {
  const resp = await sendToExtension({ t: "snapshot", seq: ++seq });
  if (resp.t === "snapshot") return snapshotText(resp.snapshot);
  if (resp.t === "error") return `快照失败: ${resp.message}`;
  return "快照失败: 扩展无响应";
});

tool(
  "browser_click",
  "点击快照中 ref 编号的元素",
  { ref: z.number().int().positive(), button: z.enum(BUTTONS).optional() },
  async (args) => executeAction("click", args),
);

tool(
  "browser_type",
  "向 ref 输入框输入文本(clear=true 先清空)",
  { ref: z.number().int().positive(), text: z.string(), clear: z.boolean().optional() },
  async (args) => executeAction("type", args),
);

tool("browser_press", "按键盘键(作用于当前聚焦元素)", { key: z.enum(PRESS_KEYS) }, async (args) =>
  executeAction("press", args),
);

tool(
  "browser_select",
  "设置 ref 下拉框的选项值",
  { ref: z.number().int().positive(), value: z.string() },
  async (args) => executeAction("select", args),
);

tool(
  "browser_scroll",
  "滚动视口(dir 方向,amount 像素;带 ref 时滚到该元素)",
  { dir: z.enum(SCROLL_DIRS), amount: z.number().int().optional(), ref: z.number().int().positive().optional() },
  async (args) => executeAction("scroll", args),
);

tool("browser_hover", "悬停 ref 元素(触发 hover 菜单)", { ref: z.number().int().positive() }, async (args) =>
  executeAction("hover", args),
);

tool("browser_goto", "跳转到指定 URL", { url: z.string() }, async (args) => executeAction("goto", args));

tool("browser_back", "浏览器后退", {}, async () => executeAction("back", {}));

tool("browser_refresh", "刷新页面", {}, async () => executeAction("refresh", {}));

tool("browser_wait", "等待页面稳定(ms 毫秒,默认 800)", { ms: z.number().int().optional() }, async (args) =>
  executeAction("wait", args),
);

tool("browser_new_tab", "新建标签页并立即跳转(url 可选,缺省开空白新标签页)", { url: z.string().regex(/^https?:\/\//).optional() }, async (args) => {
  const resp = await sendToExtension({
    t: "new-tab",
    seq: ++seq,
    ...(typeof args.url === "string" ? { url: args.url } : {}),
  });
  if (resp.t === "new-tab-result") {
    if (resp.ok) {
      return `已打开新标签页: [${resp.tabId ?? "?"}] ${resp.title ?? ""} — ${resp.url || "(空白页)"}`;
    }
    return `失败: ${resp.message ?? "未知"}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool("browser_close_tab", "关闭标签页(tabId 缺省关闭当前控制目标;关闭受控页后自动回到跟随模式)", { tabId: z.number().int().positive().optional() }, async (args) => {
  const resp = await sendToExtension({
    t: "close-tab",
    seq: ++seq,
    ...(typeof args.tabId === "number" ? { tabId: args.tabId } : {}),
  });
  if (resp.t === "close-tab-result") {
    if (resp.ok) return "已关闭";
    return `失败: ${resp.message ?? "未知"}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool("browser_screenshot", "截取当前控制页面的可见区域并返回图片(dataUrl),用于视觉理解复杂布局", {}, async () => {
  const resp = await sendToExtension({ t: "screenshot", seq: ++seq });
  if (resp.t === "screenshot-result") {
    if (resp.ok) return `截图成功(dataUrl, ${resp.dataUrl?.length ?? 0} 字符)`;
    return `失败: ${resp.message ?? "未知"}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool("browser_highlight", "高亮快照中 ref 的元素约 1 秒,让用户看到 AI 即将操作的位置", { ref: z.number().int().positive() }, async (args) =>
  executeAction("highlight", args),
);

tool("browser_activate_tab", "激活(切换到前台)标签页给用户看,但不改变控制目标", { tabId: z.number().int().positive() }, async (args) => {
  const resp = await sendToExtension({ t: "activate-tab", seq: ++seq, tabId: args.tabId as number });
  if (resp.t === "activate-tab-result") {
    if (resp.ok) return "已激活";
    return `失败: ${resp.message ?? "未知"}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool("browser_dblclick", "双击快照中 ref 的元素", { ref: z.number().int().positive() }, async (args) =>
  executeAction("dblclick", args),
);

tool("browser_key", "按键盘键(可带修饰键 ctrl/shift/alt/meta),作用于当前聚焦元素", { key: z.enum(PRESS_KEYS), modifiers: z.array(z.enum(MODIFIERS)).optional() }, async (args) =>
  executeAction("press", args),
);

tool("browser_url", "查询当前控制页面的 URL 与标题(轻量,比 snapshot 省 token)", {}, async () => {
  const resp = await sendToExtension({ t: "get-target", seq: ++seq });
  if (resp.t === "target-info") {
    if (!resp.connected) return "桥未连接(扩展未加载或 host 未启动)";
    if (!resp.target) return "没有可控制的标签页";
    return `${resp.target.url}\n${resp.target.title}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool(
  "browser_form_fill",
  "批量填写表单字段(fields: [{ref, text, clear?}],按序逐个输入)",
  {
    fields: z
      .array(
        z.object({
          ref: z.number().int().positive(),
          text: z.string(),
          clear: z.boolean().optional(),
        }),
      )
      .min(1),
  },
  async (args) => {
    const results: string[] = [];
    for (const f of (args.fields as { ref: number; text: string; clear?: boolean }[])) {
      results.push(await executeAction("type", f));
    }
    return results.join("\n");
  },
);

tool("browser_drag", "把 fromRef 元素拖拽到 toRef 元素(HTML5 拖拽)", { fromRef: z.number().int().positive(), toRef: z.number().int().positive() }, async (args) =>
  executeAction("drag", args),
);

tool("browser_duplicate_tab", "复制标签页(tabId 缺省复制当前控制目标),返回新标签页 id", { tabId: z.number().int().positive().optional() }, async (args) => {
  const resp = await sendToExtension({
    t: "duplicate-tab",
    seq: ++seq,
    ...(typeof args.tabId === "number" ? { tabId: args.tabId } : {}),
  });
  if (resp.t === "duplicate-tab-result") {
    if (resp.ok) return `已复制,新标签页 id: ${resp.tabId ?? "?"}`;
    return `失败: ${resp.message ?? "未知"}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool("browser_pin_tab", "固定/取消固定标签页(tabId 缺省操作当前控制目标;默认固定)", { tabId: z.number().int().positive().optional(), pinned: z.boolean().optional() }, async (args) => {
  const resp = await sendToExtension({
    t: "pin-tab",
    seq: ++seq,
    pinned: args.pinned !== false,
    ...(typeof args.tabId === "number" ? { tabId: args.tabId } : {}),
  });
  if (resp.t === "pin-tab-result") {
    if (resp.ok) return args.pinned !== false ? "已固定" : "已取消固定";
    return `失败: ${resp.message ?? "未知"}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool("browser_list_tabs", "列出所有打开的标签页(id/标题/URL),选择控制目标用", {}, async () => {
  const resp = await sendToExtension({ t: "list-tabs", seq: ++seq });
  if (resp.t === "tabs") {
    const lines = resp.tabs.map((t) => `[${t.id}] ${t.title} — ${t.url}${t.active ? " (当前激活)" : ""}`);
    if (lines.length === 0) return "没有可控制的标签页(需 http/https 页面)";
    return lines.join("\n");
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool("browser_control_status", "查询当前控制目标标签页与桥连接状态", {}, async () => {
  const resp = await sendToExtension({ t: "get-target", seq: ++seq });
  if (resp.t === "target-info") {
    if (!resp.connected) return "桥未连接(扩展未加载或 host 未启动)";
    if (!resp.target) {
      return "没有可控制的标签页(当前激活页需是 http/https)。用 browser_list_tabs 查看,browser_use_tab 固定目标。";
    }
    if (resp.mode === "follow") {
      return `跟随模式:控制你当前激活的标签页(当前: [${resp.target.tabId}] ${resp.target.title} — ${resp.target.url})。切换浏览器标签页即切换控制目标。`;
    }
    return `已固定控制: [${resp.target.tabId}] ${resp.target.title} — ${resp.target.url}`;
  }
  if (resp.t === "error") return `失败: ${resp.message}`;
  return "失败: 扩展无响应";
});

tool(
  "browser_use_tab",
  "选择控制目标标签页(之后所有操作作用于该页);tabId=-1 表示取消固定,回到跟随模式(控制当前激活标签页)",
  { tabId: z.number().int().refine((v) => v === -1 || v >= 1, "tabId 必须 >=1,或 -1 回到跟随模式") },
  async (args) => {
    const resp = await sendToExtension({ t: "set-target", seq: ++seq, tabId: args.tabId as number });
    if (resp.t === "set-target-result") {
      if (resp.ok) return `已切换目标: ${resp.message ?? `tab ${args.tabId}`}`;
      return `失败: ${resp.message ?? "未知"}`;
    }
    if (resp.t === "error") return `失败: ${resp.message}`;
    return "失败: 扩展无响应";
  },
);

// ---------- MCP server(会话模式) ----------

// SDK 的 Server 实例只能 connect 一次,每个 MCP session 创建独立实例。
function createMcpServer(): McpServer {
  const mcp = new McpServer({ name: "browser-bridge", version: "0.1.0" });
  for (const [name, def] of TOOLS) {
    mcp.tool(name, def.description, def.schema, async (args) => ({
      content: [{ type: "text", text: await def.handler(args as Record<string, unknown>) }],
    }));
  }
  return mcp;
}

// ---------- 无状态模式(2026-07-28 规范:跳过握手直接调用) ----------

async function handleStateless(body: Record<string, unknown> | undefined, res: ServerResponse): Promise<void> {
  const id = body?.id ?? null;
  const reply = (payload: Record<string, unknown> | undefined, status = 200): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, ...(payload ?? {}) }));
  };
  const fail = (code: number, message: string): void =>
    reply({ error: { code, message } });

  if (!body || body.method === undefined) {
    return fail(-32700, "Parse error: Invalid JSON-RPC message");
  }
  if (body.method === "tools/list") {
    const tools = [...TOOLS.entries()].map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: zodToJsonSchema(z.object(def.schema) as never, { target: "openAi" }),
    }));
    return reply({ result: { tools } });
  }
  if (body.method === "tools/call") {
    const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
    const def = typeof params.name === "string" ? TOOLS.get(params.name) : undefined;
    if (!def) return fail(-32602, `Unknown tool: ${String(params.name)}`);
    const parsed = z.object(def.schema).safeParse(params.arguments ?? {});
    if (!parsed.success) return fail(-32602, `Invalid arguments: ${parsed.error.message}`);
    try {
      const text = await def.handler(parsed.data as Record<string, unknown>);
      return reply({ result: { content: [{ type: "text", text }] } });
    } catch (err) {
      return fail(-32000, String(err));
    }
  }
  // 其他请求/通知:无内容响应
  return reply({}, 202);
}

// ---------- Streamable HTTP transport ----------

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsed: number;
}

const sessions = new Map<string, McpSession>();

// 会话过期清理:1 小时未活动的 session 关闭,防长跑泄漏
const SESSION_TTL_MS = 3600_000;
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) {
      s.transport.close();
      s.server.close();
      sessions.delete(sid);
    }
  }
}, 300_000).unref?.();

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body too large (>${MAX_BODY_BYTES})`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch (err) {
        reject(new Error(`bad json body: ${String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

// ---------- 端口自愈监听 ----------
// 从初始端口(默认 1234)开始探测,被占则 +1,最多试 20 个;
// 实际端口写入 ~/.browser-bridge/port 供 MCP 客户端发现。

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/mcp") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  try {
    const body = await readBody(req);
    const method = (body as { method?: string } | null)?.method;
    const sessionId =
      (req.headers["mcp-session-id"] as string | undefined) ?? url.searchParams.get("session_id") ?? undefined;

    // 无 session 且非 initialize:2026-07-28 规范的无状态调用
    // (跳过握手,直接 tools/list / tools/call),由 host 自带处理器应答
    if (!sessionId && method !== "initialize") {
      await handleStateless(body as Record<string, unknown> | undefined, res);
      return;
    }

    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // sessionId 在收到 initialize 请求时生成,通过回调注册
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, server, lastUsed: Date.now() });
          transport.onclose = () => sessions.delete(sid);
        },
      });
      await server.connect(transport);
      session = { transport, server, lastUsed: Date.now() };
    }
    session.lastUsed = Date.now();
    await session.transport.handleRequest(req, res, body);
  } catch (err) {
    console.error(`mcp http error: ${String(err)}`);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("internal error");
    }
  }
});

// node http 的 EADDRINUSE 是异步 error 事件,不是同步 throw
function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      resolve(false);
    };
    http.once("error", onError);
    http.listen(port, "127.0.0.1", () => {
      http.removeListener("error", onError);
      resolve(true);
    });
  });
}

for (let i = 0; i < 20; i++) {
  if (await tryListen(START_PORT + i)) {
    port = START_PORT + i;
    break;
  }
}
if (!http.listening) {
  console.error(`无法绑定端口 ${START_PORT}..${START_PORT + 19},退出`);
  process.exit(1);
}

mkdirSync(dirname(PORT_FILE), { recursive: true });
Bun.write(PORT_FILE, String(port));
console.error(`browser-bridge MCP server listening on http://127.0.0.1:${port}/mcp (port file: ${PORT_FILE})`);

// ---------- 崩溃兜底:任何未捕获异常都记录而非退出 ----------

process.on("uncaughtException", (err) => {
  console.error(`uncaught exception (ignored): ${err.stack ?? String(err)}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`unhandled rejection (ignored): ${String(err)}`);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
