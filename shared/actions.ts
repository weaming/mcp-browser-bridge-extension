// 动作类型与参数校验。MCP 工具参数 → Action → 扩展执行。

export const ACTION_NAMES = [
  "click", "type", "press", "select", "scroll", "hover",
  "goto", "back", "refresh", "wait",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export const PRESS_KEYS = ["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp"] as const;
export type PressKey = (typeof PRESS_KEYS)[number];

export const SCROLL_DIRS = ["up", "down", "left", "right"] as const;
export type ScrollDir = (typeof SCROLL_DIRS)[number];

export const BUTTONS = ["left", "right", "middle"] as const;
export type ClickButton = (typeof BUTTONS)[number];

export type Action =
  | { action: "click"; ref: number; button?: ClickButton }
  | { action: "type"; ref: number; text: string; clear?: boolean }
  | { action: "press"; key: PressKey }
  | { action: "select"; ref: number; value: string }
  | { action: "scroll"; ref?: number; dir: ScrollDir; amount?: number }
  | { action: "hover"; ref: number }
  | { action: "goto"; url: string }
  | { action: "back" }
  | { action: "refresh" }
  | { action: "wait"; ms?: number };

export interface ActionParseError {
  ok: false;
  error: string;
}

// 把 MCP 工具参数解析成合法 Action;非法返回错误信息。
export function actionFromArgs(kind: ActionName, args: Record<string, unknown>): Action | ActionParseError {
  const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
  switch (kind) {
    case "click": {
      if (!isInt(args.ref)) return { ok: false, error: "click 需要整数 ref" };
      const button = args.button as ClickButton | undefined;
      if (button !== undefined && !(BUTTONS as readonly string[]).includes(button)) {
        return { ok: false, error: "click button 非法" };
      }
      return { action: "click", ref: args.ref, ...(button ? { button } : {}) };
    }
    case "type": {
      if (!isInt(args.ref)) return { ok: false, error: "type 需要整数 ref" };
      if (typeof args.text !== "string") return { ok: false, error: "type 需要 text 字符串" };
      return {
        action: "type",
        ref: args.ref,
        text: args.text,
        ...(typeof args.clear === "boolean" ? { clear: args.clear } : {}),
      };
    }
    case "press": {
      const key = args.key as PressKey | undefined;
      if (!key || !(PRESS_KEYS as readonly string[]).includes(key)) {
        return { ok: false, error: "press key 非法" };
      }
      return { action: "press", key };
    }
    case "select": {
      if (!isInt(args.ref)) return { ok: false, error: "select 需要整数 ref" };
      if (typeof args.value !== "string") return { ok: false, error: "select 需要 value 字符串" };
      return { action: "select", ref: args.ref, value: args.value };
    }
    case "scroll": {
      const dir = args.dir as ScrollDir | undefined;
      if (!dir || !(SCROLL_DIRS as readonly string[]).includes(dir)) {
        return { ok: false, error: "scroll 需要合法 dir" };
      }
      const a: Action = { action: "scroll", dir };
      if (isInt(args.ref)) a.ref = args.ref;
      if (typeof args.amount === "number" && Number.isInteger(args.amount)) a.amount = args.amount;
      return a;
    }
    case "hover": {
      if (!isInt(args.ref)) return { ok: false, error: "hover 需要整数 ref" };
      return { action: "hover", ref: args.ref };
    }
    case "goto": {
      if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)) {
        return { ok: false, error: "goto 需要 http(s) url" };
      }
      return { action: "goto", url: args.url };
    }
    case "wait":
      return {
        action: "wait",
        ...(typeof args.ms === "number" && args.ms > 0 ? { ms: Math.min(args.ms, 60_000) } : {}),
      };
    case "back":
      return { action: "back" };
    case "refresh":
      return { action: "refresh" };
  }
}
