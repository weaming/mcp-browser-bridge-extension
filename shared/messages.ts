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

export type ContentRequest =
  | { kind: "snapshot"; seq: number }
  | { kind: "execute"; seq: number; action: Action };

export type ContentResponse =
  | { kind: "snapshot"; seq: number; url: string; title: string; snapshot: Snapshot }
  | { kind: "snapshot-error"; seq: number; code: "no-content" | "not-injectable"; message: string }
  | {
      kind: "execute-result";
      seq: number;
      ok: boolean;
      code?: "stale-ref" | "nav-error" | "rejected";
      detail?: string;
    };

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
  | { t: "execute"; seq: number; action: Action }
  | { t: "list-tabs"; seq: number }
  | { t: "set-target"; seq: number; tabId: number }
  | { t: "get-target"; seq: number }
  | { t: "new-tab"; seq: number; url?: string }
  | { t: "close-tab"; seq: number; tabId?: number }
  | { t: "get-port"; seq: number }
  | { t: "ping" };

export type NativeResponse =
  | { t: "snapshot"; seq: number; url: string; title: string; snapshot: Snapshot }
  | { t: "snapshot-error"; seq: number; code: string; message: string }
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
