// 消息类型:content↔background、background↔host(native messaging 帧)。
// host 是 MCP 协议 ↔ 帧协议的翻译器。

import type { Action } from "./actions";

// ---------- 快照 ----------

export interface SnapshotNode {
  ref: number; // 1..N,本轮快照内唯一,按 DOM 顺序
  tag: string; // BUTTON/A/INPUT/SELECT/TEXTAREA/...
  type?: string; // input[type]
  text: string; // text || aria-label || placeholder 去重,≤80 字符
  href?: string; // a[href],≤200
  name?: string; // input[name]
  visible: boolean;
  rect?: { x: number; y: number; w: number; h: number }; // 视口相对整数坐标
  disabled?: boolean;
  checked?: boolean;
  value?: string; // ≤60
  opts?: string[]; // select 选项文本,≤8 个
}

export interface Snapshot {
  url: string;
  title: string;
  ts: number;
  scroll: { x: number; y: number; vh: number; vw: number };
  nodes: SnapshotNode[];
  truncated: boolean;
}

// ---------- content ↔ background ----------

export type ExtractFormat = "markdown" | "html" | "raw"; // raw:原始 body HTML(分析页面结构用)

export type EvalWorld = "main" | "isolated"; // main=页面真实上下文(可读页面变量);isolated=content script 世界

export type ContentRequest =
  | { kind: "ping"; seq: number }
  | { kind: "snapshot"; seq: number }
  | { kind: "extract"; seq: number; format?: ExtractFormat }
  | { kind: "execute"; seq: number; action: Action };

export type ContentResponse =
  | { kind: "pong"; seq: number }
  | { kind: "snapshot"; seq: number; url: string; title: string; snapshot: Snapshot }
  | { kind: "snapshot-error"; seq: number; code: "no-content" | "not-injectable"; message: string }
  | { kind: "extract-result"; seq: number; ok: boolean; url?: string; title?: string; content?: string; fallback?: boolean; message?: string }
  | {
      kind: "execute-result";
      seq: number;
      ok: boolean;
      code?: "stale-ref" | "nav-error" | "rejected";
      detail?: string;
    };

// ---------- 网络抓包(页面内钩子的读取结果) ----------

export interface NetworkEntryView {
  id: number;
  kind: "fetch" | "xhr";
  method: string;
  url: string;
  status: number | null;
  ok: boolean | null;
  durationMs: number | null;
  startTs: number;
  requestHeaders?: Record<string, string>;
  requestHeadersRaw?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  error?: string;
  note?: string;
}

export interface NetworkReadView {
  installed: boolean;
  installedAt: number | null;
  total: number; // 缓冲区现有条数
  dropped: number; // 因超出上限被丢弃的条数
  nextId: number;
  entries: NetworkEntryView[];
}

// ---------- 标签页信息 ----------

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  pinned?: boolean;
}

// ---------- background ↔ host(native messaging 帧) ----------

export type NativeRequest =
  | { t: "snapshot"; seq: number }
  | { t: "extract"; seq: number; format?: ExtractFormat }
  | { t: "execute"; seq: number; action: Action }
  | { t: "list-tabs"; seq: number }
  | { t: "set-target"; seq: number; tabId: number }
  | { t: "get-target"; seq: number }
  | { t: "new-tab"; seq: number; url?: string }
  | { t: "close-tab"; seq: number; tabId?: number }
  | { t: "activate-tab"; seq: number; tabId: number }
  | { t: "duplicate-tab"; seq: number; tabId?: number }
  | { t: "pin-tab"; seq: number; tabId?: number; pinned: boolean }
  | { t: "screenshot"; seq: number }
  | { t: "get-port"; seq: number }
  | { t: "eval"; seq: number; code: string; world: EvalWorld; awaitResult: boolean; timeoutMs: number }
  | { t: "reload-ext"; seq: number }
  | {
      t: "net";
      seq: number;
      op: "install" | "list" | "clear";
      force?: boolean; // install:丢掉旧状态重建(修复被外部改坏的钩子)
      filter?: string;
      limit?: number;
      includeBody?: boolean;
      redact?: boolean;
      sinceId?: number;
    }
  | { t: "ping" };

export type NativeResponse =
  | { t: "snapshot"; seq: number; url: string; title: string; snapshot: Snapshot }
  | { t: "snapshot-error"; seq: number; code: string; message: string }
  | { t: "extract-result"; seq: number; ok: boolean; url?: string; title?: string; content?: string; fallback?: boolean; message?: string }
  | {
      t: "execute-result";
      seq: number;
      ok: boolean;
      code?: "stale-ref" | "nav-error" | "rejected";
      detail?: string;
    }
  | { t: "tabs"; seq: number; tabs: TabInfo[] }
  | { t: "set-target-result"; seq: number; ok: boolean; message?: string }
  | {
      t: "target-info";
      seq: number;
      target: { tabId: number; title: string; url: string } | null;
      connected: boolean;
      mode: "follow" | "fixed"; // follow=跟随当前激活标签页;fixed=固定目标
    }
  | { t: "port-info"; seq: number; port: number }
  | {
      t: "new-tab-result";
      seq: number;
      ok: boolean;
      tabId?: number;
      title?: string;
      url?: string;
      message?: string;
    }
  | { t: "close-tab-result"; seq: number; ok: boolean; message?: string }
  | { t: "activate-tab-result"; seq: number; ok: boolean; message?: string }
  | { t: "duplicate-tab-result"; seq: number; ok: boolean; tabId?: number; message?: string }
  | { t: "pin-tab-result"; seq: number; ok: boolean; message?: string }
  | { t: "screenshot-result"; seq: number; ok: boolean; dataUrl?: string; message?: string }
  | { t: "eval-result"; seq: number; ok: boolean; value?: string; error?: string }
  | { t: "reload-result"; seq: number; ok: boolean; message?: string }
  | { t: "net-result"; seq: number; ok: boolean; op: string; snapshot?: NetworkReadView; message?: string }
  | { t: "pong" }
  | { t: "error"; seq: number; message: string };

// ---------- popup ↔ background ----------

export type PopupRequest = { kind: "get-status" } | { kind: "set-target"; tabId: number };

export type PopupResponse =
  | {
      kind: "status";
      connected: boolean; // 扩展是否持有 host 连接(Chrome 只保活一个 host)
      error?: string | null; // host 连接错误详情(排查用)
      target?: { tabId: number; title: string; url: string } | null;
      mode?: "follow" | "fixed";
      port?: number | null; // host 的 MCP 端口
      tab?: { id: number; title: string; url: string };
    };
