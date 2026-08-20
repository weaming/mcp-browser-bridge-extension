// content script:抓页面快照(可交互元素 + ref 编号)与执行操作指令。
// 快照时重建 refMap;执行按 ref 查 Map,页面重渲染导致 ref 失效返回 stale-ref。

import type { Action } from "../shared/actions";
import type { ContentRequest, ContentResponse, Snapshot, SnapshotNode } from "../shared/messages";
import { buildExtract } from "./extract";

const SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=combobox]",
  "[role=menuitem]",
  "[contenteditable]",
  "[tabindex]",
  "summary",
  "[onclick]",
].join(", ");

const MAX_NODES = 120;

let refMap = new Map<number, HTMLElement>();

// ---------- 快照 ----------

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function nodeText(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return clamp(aria, 80);
  const ph = el.getAttribute("placeholder");
  if (ph) return clamp(ph, 80);
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return clamp(t, 80);
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function describe(el: HTMLElement): SnapshotNode {
  const rect = el.getBoundingClientRect();
  const tag = el.tagName;
  const node: SnapshotNode = {
    ref: 0, // 稍后编号
    tag,
    text: nodeText(el),
    visible: isVisible(el),
  };
  const type = el.getAttribute("type");
  if (type) node.type = type;
  const href = el.getAttribute("href");
  if (href) node.href = clamp(href, 200);
  const name = el.getAttribute("name");
  if (name) node.name = name;
  if (rect.width > 0 && rect.height > 0) {
    node.rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }
  if (el instanceof HTMLInputElement) {
    if (el.disabled) node.disabled = true;
    if (el.checked) node.checked = true;
    if (el.value) node.value = clamp(el.value, 60);
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.disabled) node.disabled = true;
    if (el.value) node.value = clamp(el.value, 60);
  } else if (el instanceof HTMLSelectElement) {
    if (el.disabled) node.disabled = true;
    node.opts = [...el.options].slice(0, 8).map((o) => clamp(o.text.trim(), 40));
    if (el.value) node.value = clamp(el.value, 60);
  }
  return node;
}

function buildSnapshot(): Snapshot {
  refMap = new Map();
  const all = [...document.querySelectorAll<HTMLElement>(SELECTOR)];
  const visible = all.filter(isVisible);
  const rest = all.filter((el) => !visible.includes(el));
  const selected = visible.concat(rest).slice(0, MAX_NODES);

  const nodes: SnapshotNode[] = selected.map((el, i) => {
    const n = describe(el);
    n.ref = i + 1;
    refMap.set(n.ref, el);
    return n;
  });

  return {
    url: location.href,
    title: document.title,
    ts: Date.now(),
    scroll: {
      x: Math.round(scrollX),
      y: Math.round(scrollY),
      vh: window.innerHeight,
      vw: window.innerWidth,
    },
    nodes,
    truncated: all.length > MAX_NODES,
  };
}

// ---------- 执行 ----------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function doClick(el: HTMLElement): Promise<void> {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  await sleep(100);
  el.focus();
  for (const type of ["mousedown", "mouseup", "click"] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  }
}

async function doType(el: HTMLElement, text: string, clear: boolean): Promise<void> {
  el.focus();
  if (clear) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.select();
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    document.execCommand("delete");
  }
  const ok = document.execCommand("insertText", false, text);
  if (!ok && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    el.value += text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 };

function doPress(key: string, modifiers: string[] = []): void {
  const el = (document.activeElement as HTMLElement | null) ?? document.body;
  const keyCode = KEY_CODES[key] ?? 0;
  const mod = {
    ctrlKey: modifiers.includes("ctrl"),
    shiftKey: modifiers.includes("shift"),
    altKey: modifiers.includes("alt"),
    metaKey: modifiers.includes("meta"),
  };
  for (const type of ["keydown", "keypress", "keyup"] as const) {
    const ev = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...mod });
    Object.defineProperty(ev, "keyCode", { value: keyCode });
    Object.defineProperty(ev, "which", { value: keyCode });
    el.dispatchEvent(ev);
  }
  // 合成键盘事件不会触发浏览器原生表单提交;无修饰键的 Enter 用 requestSubmit 兜底
  if (key === "Enter" && modifiers.length === 0) {
    const form = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.form : null;
    form?.requestSubmit?.();
  }
}

function doDblClick(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus();
  for (const type of ["mousedown", "mouseup", "click", "mousedown", "mouseup", "dblclick"] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  }
}

async function doHighlight(el: HTMLElement): Promise<void> {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  const original = el.style.outline;
  el.style.outline = "3px solid #ffb454";
  el.style.outlineOffset = "2px";
  await sleep(1200);
  el.style.outline = original;
  el.style.outlineOffset = "";
}

function doDrag(from: HTMLElement, to: HTMLElement): void {
  from.scrollIntoView({ block: "center" });
  const rect = to.getBoundingClientRect();
  const data = new DataTransfer();
  for (const type of ["dragstart", "dragenter", "dragover", "drop", "dragend"] as const) {
    from.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    );
  }
}

function doSelect(el: HTMLElement, value: string): boolean {
  if (!(el instanceof HTMLSelectElement)) return false;
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function doScroll(el: HTMLElement | undefined, dir: string, amount?: number): void {
  if (el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const sign = dir === "up" || dir === "left" ? -1 : 1;
  const amt = amount ?? 400;
  if (dir === "up" || dir === "down") {
    window.scrollBy({ top: sign * amt, behavior: "smooth" });
  } else {
    window.scrollBy({ left: sign * amt, behavior: "smooth" });
  }
}

function doHover(el: HTMLElement): void {
  el.scrollIntoView({ block: "center" });
  for (const type of ["mouseover", "mouseenter", "mousemove"] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }
}

const WAIT_UI_TIMEOUT_MS = 5000;
const WAIT_POLL_MS = 100;

function uiCondMet(selector?: string, text?: string): boolean {
  if (selector) {
    try {
      return document.querySelector(selector) !== null;
    } catch {
      return false; // 非法选择器视为不匹配,由超时兜底
    }
  }
  if (text) return (document.body.innerText ?? "").includes(text);
  return false;
}

async function execute(action: Action): Promise<ContentResponse> {
  if (action.action === "wait_for") {
    if (action.ms !== undefined) {
      await sleep(action.ms);
      return { kind: "execute-result", seq: 0, ok: true };
    }
    const deadline = Date.now() + WAIT_UI_TIMEOUT_MS;
    while (!uiCondMet(action.selector, action.text)) {
      if (Date.now() >= deadline) {
        const what = action.selector ? `selector ${action.selector}` : `文本 "${action.text}"`;
        return {
          kind: "execute-result",
          seq: 0,
          ok: false,
          code: "rejected",
          detail: `等待超时(${WAIT_UI_TIMEOUT_MS}ms):${what} 未出现`,
        };
      }
      await sleep(WAIT_POLL_MS);
    }
    return { kind: "execute-result", seq: 0, ok: true };
  }
  if (action.action === "goto") {
    location.href = action.url;
    return { kind: "execute-result", seq: 0, ok: true };
  }
  if (action.action === "back") {
    history.back();
    return { kind: "execute-result", seq: 0, ok: true };
  }
  if (action.action === "refresh") {
    location.reload();
    return { kind: "execute-result", seq: 0, ok: true };
  }

  if (action.action === "press") {
    doPress(action.key, action.modifiers);
    return { kind: "execute-result", seq: 0, ok: true };
  }

  try {
    if (action.action === "scroll") {
      const el = action.ref !== undefined ? refMap.get(action.ref) : undefined;
      if (action.ref !== undefined && el === undefined) {
        return { kind: "execute-result", seq: 0, ok: false, code: "stale-ref" };
      }
      doScroll(el, action.dir, action.amount);
      return { kind: "execute-result", seq: 0, ok: true };
    }
    if (action.action === "drag") {
      const from = refMap.get(action.fromRef);
      const to = refMap.get(action.toRef);
      if (from === undefined || to === undefined) {
        return { kind: "execute-result", seq: 0, ok: false, code: "stale-ref", detail: "拖拽源/目标 ref 不存在" };
      }
      doDrag(from, to);
      return { kind: "execute-result", seq: 0, ok: true };
    }

    const el = refMap.get(action.ref ?? -1);
    if (el === undefined) {
      return {
        kind: "execute-result",
        seq: 0,
        ok: false,
        code: "stale-ref",
        detail: `ref ${action.ref} 不存在(refMap ${refMap.size}, flag ${window.__browserBridgeInjected})`,
      };
    }

    switch (action.action) {
      case "click":
        await doClick(el);
        break;
      case "type":
        await doType(el, action.text, action.clear === true);
        break;
      case "dblclick":
        doDblClick(el);
        break;
      case "highlight":
        await doHighlight(el);
        break;
      case "select":
        if (!doSelect(el, action.value)) {
          return { kind: "execute-result", seq: 0, ok: false, code: "rejected", detail: "非 select 元素" };
        }
        break;
      case "hover":
        doHover(el);
        break;
    }
    return { kind: "execute-result", seq: 0, ok: true };
  } catch (err) {
    return { kind: "execute-result", seq: 0, ok: false, code: "rejected", detail: String(err) };
  }
}

// ---------- 消息 ----------

// 幂等注入:静态 content_scripts 与动态 executeScript 可能重复注入;
// 扩展重载后旧实例不会自动移除,通过页面消息广播"接管",旧实例自动停用。
declare global {
  interface Window {
    __browserBridgeInjected?: boolean;
  }
}

const INSTANCE_ID = Math.random().toString(36).slice(2);

function handleMessage(msg: ContentRequest, _sender: unknown, sendResponse: (r: ContentResponse) => void): boolean {
  void (async () => {
    if (msg.kind === "snapshot") {
      const s = buildSnapshot();
      sendResponse({
        kind: "snapshot",
        seq: msg.seq,
        url: s.url,
        title: s.title,
        snapshot: s,
      } satisfies ContentResponse);
    } else if (msg.kind === "extract") {
      const r = buildExtract(msg.format);
      r.seq = msg.seq;
      sendResponse(r);
    } else if (msg.kind === "execute") {
      const r = await execute(msg.action);
      r.seq = msg.seq;
      sendResponse(r);
    }
  })();
  return true; // 异步响应
}

if (!window.__browserBridgeInjected) {
  window.__browserBridgeInjected = true;

  // 旧实例(扩展重载前的)收到接管广播后停用自己,避免双实例竞争
  window.addEventListener("message", (e) => {
    const d = e.data as { type?: string; id?: string };
    if (d?.type === "browser-bridge-takeover" && d.id !== INSTANCE_ID) {
      window.__browserBridgeInjected = false;
      chrome.runtime.onMessage.removeListener(handleMessage);
    }
  });

  chrome.runtime.onMessage.addListener(handleMessage);
  window.postMessage({ type: "browser-bridge-takeover", id: INSTANCE_ID }, "*");
}
