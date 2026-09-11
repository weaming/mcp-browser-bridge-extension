// browser-bridge host:唯一进程,两个角色:
// 1. native messaging host(stdin/stdout 帧协议)—— 与 Chrome 扩展通信
// 2. MCP server(Streamable HTTP,127.0.0.1:1234 起)—— 对 AI/程序暴露浏览器控制工具
//    SDK v2 双协议:modern 2026-07-28(server/discover 协商)+ legacy 2025 系列(无状态)
// 工具调用 → 帧请求 → 扩展执行 → 结果转 MCP 响应。
// BROWSER_BRIDGE_MOCK=1 时帧请求由内部模拟应答(无扩展也能测 MCP API)。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { encodeFrame, FrameReader } from "./native-protocol";
import { actionFromArgs, PRESS_KEYS, SCROLL_DIRS, BUTTONS, MODIFIERS } from "../shared/actions";
import type { EvalWorld, ExtractFormat, NativeRequest, NativeResponse, NetworkReadView, Snapshot } from "../shared/messages";

const START_PORT = Number(process.env.BROWSER_BRIDGE_PORT ?? 1234);
// 端口文件路径可覆盖(测试/多实例场景避免互相污染)
const PORT_FILE = process.env.BROWSER_BRIDGE_PORT_FILE ?? join(homedir(), ".browser-bridge", "port");
const MOCK = process.env.BROWSER_BRIDGE_MOCK === "1";
let port = START_PORT; // 实际监听端口,由下方端口探测决定

// 截图缓存目录:保存到本地文件,返回路径而非 base64;启动时清理 3 天前的缓存
const CACHE_DIR = process.env.BROWSER_BRIDGE_CACHE_DIR ?? join(homedir(), ".browser-bridge", "cache");
const CACHE_TTL_MS = 3 * 24 * 3600 * 1000;

function cleanCache(): void {
  const now = Date.now();
  let removed = 0;
  for (const f of readdirSync(CACHE_DIR)) {
    const p = join(CACHE_DIR, f);
    try {
      if (statSync(p).isFile() && now - statSync(p).mtimeMs > CACHE_TTL_MS) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      // 文件可能已被移除,忽略
    }
  }
  if (removed > 0) console.error(`cache cleaned: removed ${removed} file(s) older than 3 days`);
}

mkdirSync(CACHE_DIR, { recursive: true });
cleanCache();
// 长运行时周期性清理(启动一次 + 每小时一次)
setInterval(cleanCache, 3600 * 1000).unref?.();

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
  if (msg.t === "extract") {
    return Promise.resolve({
      t: "extract-result",
      seq: msg.seq,
      ok: true,
      url: "https://example.com/mock",
      title: "Mock Page",
      content: "# Mock Page\n\n这是 mock 的正文 Markdown 内容。",
    });
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
  if (msg.t === "reload-ext") {
    return Promise.resolve({
      t: "reload-result",
      seq: msg.seq,
      ok: true,
      message: "mock 重载已触发",
    });
  }
  if (msg.t === "eval") {
    return Promise.resolve({
      t: "eval-result",
      seq: msg.seq,
      ok: true,
      value: JSON.stringify({ ok: true, type: "string", value: `mock-eval(${msg.code.slice(0, 20)})` }),
    });
  }
  if (msg.t === "net") {
    const snapshot: NetworkReadView = {
      installed: true,
      installedAt: 0,
      total: 1,
      dropped: 0,
      nextId: 2,
      entries: [
        {
          id: 1,
          kind: "fetch",
          method: "POST",
          url: "https://example.com/mock/api",
          status: 200,
          ok: true,
          durationMs: 12,
          startTs: 0,
          requestHeaders: { authorization: "«redacted»" },
          ...(msg.includeBody ? { responseBody: '{"ok":true}' } : {}),
        },
      ],
    };
    return Promise.resolve({
      t: "net-result",
      seq: msg.seq,
      ok: true,
      op: msg.op ?? "list",
      snapshot,
      message: `mock net ${msg.op ?? "list"}`,
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
// handler 可返回纯文本,或结构化 content(如 image,让 AI 真正"看见"图片)
interface ToolContentItem {
  type: "text" | "image";
  text?: string;
  data?: string; // image 的 base64
  mimeType?: string;
}
type ToolOutput = string | ToolContentItem[];

interface ToolDef {
  description: string;
  schema: z.ZodRawShape; // 普通对象 shape,注册时包成 z.object 传给 SDK
  handler: (args: Record<string, unknown>) => Promise<ToolOutput>;
}

const TOOLS = new Map<string, ToolDef>();

function tool(
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (args: Record<string, unknown>) => Promise<ToolOutput>,
): void {
  TOOLS.set(name, { description, schema, handler });
}

// 把 handler 输出统一成 MCP content 数组
function toContent(out: ToolOutput): ToolContentItem[] {
  return typeof out === "string" ? [{ type: "text", text: out }] : out;
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
  "browser_extract",
  "提取当前控制页面的正文内容并转为 Markdown(读文章/抓数据用,比 snapshot 省 token;对话页按问答轮次组装);format=html 返回净化 HTML,format=raw 返回原始 body HTML",
  { format: z.enum(["markdown", "html", "raw"]).optional() },
  async (args) => {
    const resp = await sendToExtension({ t: "extract", seq: ++seq, format: args.format as ExtractFormat | undefined }, 30_000);
    if (resp.t === "extract-result") {
      if (!resp.ok) return `提取失败: ${resp.message ?? "未知"}`;
      const head = [`URL: ${resp.url ?? ""}`, `标题: ${resp.title ?? ""}`];
      if (resp.fallback) head.push("(非文章型页面,以下为整页转换结果)");
      return `${head.join("\n")}\n\n${resp.content ?? ""}`;
    }
    if (resp.t === "error") return `提取失败: ${resp.message}`;
    return "提取失败: 扩展无响应";
  },
);

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

tool(
  "browser_wait_for",
  "等待条件满足,二选一(同时传或都不传会报错):ms=定时等待毫秒数;selector=等元素出现,或 text=等页面出现指定文本(UI 条件最多等 5 秒)",
  {
    ms: z.number().int().positive().optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
  },
  async (args) => {
    const action = actionFromArgs("wait_for", args);
    if (!("action" in action)) return `参数错误: ${action.error}`;
    // 定时等待最长 60s,扩展响应超时需相应放宽
    const timeoutMs = typeof args.ms === "number" ? Math.min(args.ms, 60_000) + 2000 : 10_000;
    const resp = await sendToExtension({ t: "execute", seq: ++seq, action }, timeoutMs);
    if (resp.t === "execute-result") {
      if (resp.ok) return "ok";
      return `失败: ${resp.code ?? "unknown"}${resp.detail ? ` — ${resp.detail}` : ""}`;
    }
    if (resp.t === "error") return `失败: ${resp.message}`;
    return "失败: 扩展无响应";
  },
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

tool("browser_screenshot", "截取当前控制页面的可见区域,保存到缓存目录并返回图片路径(AI 可读取该文件查看页面)", {}, async () => {
  const resp = await sendToExtension({ t: "screenshot", seq: ++seq });
  if (resp.t === "screenshot-result") {
    if (resp.ok && resp.dataUrl) {
      const comma = resp.dataUrl.indexOf(",");
      const meta = comma > 0 ? resp.dataUrl.slice(0, comma) : "";
      const base64 = comma > 0 ? resp.dataUrl.slice(comma + 1) : "";
      const ext = meta.includes("jpeg") ? "jpg" : "png";
      const file = join(CACHE_DIR, `shot-${Date.now()}.${ext}`);
      try {
        Bun.write(file, Buffer.from(base64, "base64"));
        return `已保存截图: ${file}`;
      } catch (err) {
        return `截图保存失败: ${String(err)}`;
      }
    }
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

// ---------- 页面内执行与网络抓包 ----------

// 扩展回传的求值结果是 JSON 字符串(避免 structured clone 对 DOM/循环引用报错)
function formatEvalResult(raw: string | undefined, error: string | undefined): string {
  if (raw === undefined) return `失败: ${error ?? "扩展无响应"}`;
  try {
    const p = JSON.parse(raw) as { ok: boolean; type?: string; value?: unknown; error?: string; stack?: string };
    if (!p.ok) {
      const tail = p.stack ? `\n${p.stack.split("\n").slice(0, 4).join("\n")}` : "";
      return `执行错误: ${p.error ?? "未知"}${tail}`;
    }
    const value = typeof p.value === "string" ? p.value : JSON.stringify(p.value, null, 2);
    return `ok · ${p.type ?? "unknown"}\n${value ?? "undefined"}`;
  } catch {
    return raw;
  }
}

// 单条请求的文本化;body 截断避免把上下文冲爆(扩展侧已封顶 20000 字符)
const BODY_PREVIEW = 1200;
function previewBody(s: string): string {
  return s.length > BODY_PREVIEW ? `${s.slice(0, BODY_PREVIEW)}…(共 ${s.length} 字符,已截断)` : s;
}

function formatNetworkSnapshot(s: NetworkReadView): string {
  if (!s.installed) return "钩子未安装:先调用 browser_network(op=install) 再操作页面,之后 op=list 查看";
  const head = `缓冲区 ${s.total} 条${s.dropped ? `(已丢弃最旧 ${s.dropped} 条)` : ""};本次返回 ${s.entries.length} 条`;
  if (s.entries.length === 0) return `${head}\n(无匹配记录)`;
  const blocks = s.entries.map((e) => {
    const status = e.status === null ? (e.error ? `失败(${e.error})` : "进行中") : String(e.status);
    const dur = e.durationMs === null ? "" : ` ${e.durationMs}ms`;
    const lines = [`#${e.id} [${e.kind}] ${e.method} ${e.url} → ${status}${dur}`];
    if (e.requestHeaders && Object.keys(e.requestHeaders).length) {
      lines.push(`  req-headers: ${Object.entries(e.requestHeaders).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
    if (e.requestBody) lines.push(`  req-body: ${previewBody(e.requestBody)}`);
    if (e.responseHeaders && Object.keys(e.responseHeaders).length) {
      lines.push(`  resp-headers: ${Object.entries(e.responseHeaders).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
    if (e.responseBody) lines.push(`  resp-body: ${previewBody(e.responseBody)}`);
    if (e.note) lines.push(`  note: ${e.note}`);
    return lines.join("\n");
  });
  return `${head}\n\n${blocks.join("\n\n")}`;
}

tool(
  "browser_eval",
  "在受控页面执行 JavaScript(默认 world=main:页面真实上下文,可读 localStorage/userToken、调用页面函数、改 DOM);结果为 JSON 化文本,超长自动截断",
  {
    code: z.string().min(1),
    world: z.enum(["main", "isolated"]).optional(),
    await: z.boolean().optional(),
    timeout_ms: z.number().int().positive().max(30_000).optional(),
  },
  async (args) => {
    const timeoutMs = Math.min(typeof args.timeout_ms === "number" ? args.timeout_ms : 5000, 30_000);
    const resp = await sendToExtension(
      {
        t: "eval",
        seq: ++seq,
        code: args.code as string,
        world: (args.world as EvalWorld | undefined) ?? "main",
        awaitResult: args.await !== false,
        timeoutMs,
      },
      timeoutMs + 5000,
    );
    if (resp.t === "eval-result") return formatEvalResult(resp.ok ? resp.value : undefined, resp.error);
    if (resp.t === "error") return `失败: ${resp.message}`;
    return "失败: 扩展无响应";
  },
);

tool(
  "browser_network",
  "查看/管理受控页面的网络请求:op=list(默认)/install(装钩子)/clear;钩子装在页面里,fetch 与 XHR(含流式 SSE)都能记录;凭据类 header 默认打码,redact=false 可关闭;install 加 force=true 可强制重建(修钩子)",
  {
    op: z.enum(["list", "install", "clear"]).optional(),
    force: z.boolean().optional(),
    filter: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
    include_body: z.boolean().optional(),
    redact: z.boolean().optional(),
    since_id: z.number().int().nonnegative().optional(),
  },
  async (args) => {
    const op = (args.op as "list" | "install" | "clear" | undefined) ?? "list";
    const resp = await sendToExtension(
      {
        t: "net",
        seq: ++seq,
        op,
        ...(args.force === true ? { force: true } : {}),
        ...(typeof args.filter === "string" ? { filter: args.filter } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        includeBody: args.include_body === true,
        redact: args.redact !== false,
        ...(typeof args.since_id === "number" ? { sinceId: args.since_id } : {}),
      },
      20_000,
    );
    if (resp.t === "net-result") {
      if (!resp.ok) return `失败: ${resp.message ?? "未知"}`;
      if (op !== "list") return resp.message ?? "ok";
      if (!resp.snapshot) return "失败: 未返回数据";
      return formatNetworkSnapshot(resp.snapshot);
    }
    if (resp.t === "error") return `失败: ${resp.message}`;
    return "失败: 扩展无响应";
  },
);

tool(
  "browser_reload_extension",
  "重载 browser-bridge 扩展,使磁盘上的新代码生效(改完扩展文件后用);重载会断开 host,≤30s 后自动用新二进制重连",
  {},
  async () => {
    const resp = await sendToExtension({ t: "reload-ext", seq: ++seq });
    if (resp.t === "reload-result") return resp.ok ? (resp.message ?? "已触发重载") : `失败: ${resp.message ?? "未知"}`;
    if (resp.t === "error") return `失败: ${resp.message}`;
    return "失败: 扩展无响应";
  },
);

// ---------- MCP server ----------

// HTTP 入口按请求创建实例(无状态),工具定义共享只读 TOOLS。
function createMcpServer(): McpServer {
  const mcp = new McpServer({ name: "browser-bridge", version: "0.1.1" });
  for (const [name, def] of TOOLS) {
    // SDK 泛型重载无法从动态 schema/handler 推断,用 any 逃逸
    (mcp as unknown as {
      registerTool: (n: string, cfg: Record<string, unknown>, cb: (a: Record<string, unknown>) => unknown) => unknown;
    }).registerTool(
      name,
      { description: def.description, inputSchema: z.object(def.schema) },
      async (args: Record<string, unknown>) => ({
        content: toContent(await def.handler(args)),
      }),
    );
  }
  return mcp;
}

// ---------- Streamable HTTP serving(v2 双协议时代) ----------

// createMcpHandler 同时服务两个协议版本:
// - modern(2026-07-28):响应 server/discover 协商探测,报告 supportedVersions;
// - legacy(2025 系列,默认 stateless):老客户端的 plain initialize 直接可用。
// 之前手写的无 session 短路应答会把探测请求吞成空 202,导致 ZCode 版本协商 5s 超时。
const mcpNodeHandler = toNodeHandler(createMcpHandler(() => createMcpServer()));

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
    await mcpNodeHandler(req, res);
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
