// 注入到页面执行的函数(MAIN world / ISOLATED world)。
//
// 约束:这些函数由 chrome.scripting.executeScript 序列化后注入页面,
// 必须**自包含** —— 不能引用模块作用域的变量/函数,只能用参数、局部变量和页面全局对象。
// 因此本文件里的辅助逻辑都写成函数内部定义。
// (type-only import 会被构建擦除,不影响自包含性)

import type { NetworkEntryView, NetworkReadView, WebMcpCallView, WebMcpProbeView, WebMcpToolView } from "../shared/messages";

// ---------- 页面内求值 ----------

// 求值并把结果序列化成 JSON 字符串(避免 structured clone 对 DOM/循环引用报错)
export function evalInPage(code: string, awaitResult: boolean, timeoutMs: number): Promise<string> {
  const MAX_STR = 4000;
  const MAX_ITEMS = 100;
  const MAX_DEPTH = 4;
  const seen = new WeakSet<object>();

  const clip = (s: string): string =>
    s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…(+${s.length - MAX_STR} chars)` : s;

  const describe = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === "string") return clip(v as string);
    if (t === "number" || t === "boolean") return v;
    if (t === "bigint") return `${String(v)}n`;
    if (t === "symbol") return String(v);
    if (t === "function") {
      let src = "";
      try {
        src = clip(String(v).replace(/\s+/g, " ").slice(0, 200));
      } catch {
        src = "(无法读取源码)";
      }
      return `[Function ${(v as { name?: string }).name || "anonymous"}] ${src}`;
    }
    const el = v as Element;
    if (typeof Element !== "undefined" && el instanceof Element) {
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
      const text = clip((el.textContent ?? "").trim().slice(0, 200));
      return `<${el.tagName.toLowerCase()}${id}${cls}> ${text}`;
    }
    const o = v as object;
    if (seen.has(o)) return "[Circular]";
    if (depth >= MAX_DEPTH) return "[Depth limit]";
    seen.add(o);
    if (Array.isArray(o)) {
      const arr = o.slice(0, MAX_ITEMS).map((x) => describe(x, depth + 1));
      if (o.length > MAX_ITEMS) arr.push(`…(+${o.length - MAX_ITEMS} more)`);
      return arr;
    }
    if (o instanceof Map) return describe(Array.from(o.entries()), depth + 1);
    if (o instanceof Set) return describe(Array.from(o.values()), depth + 1);
    if (o instanceof Error) return { name: o.name, message: o.message, stack: clip(String(o.stack ?? "")) };
    if (o instanceof Date) return o.toISOString();
    if (ArrayBuffer.isView(o)) return `<${o.constructor.name} ${o.byteLength} bytes>`;
    if (o instanceof ArrayBuffer) return `<ArrayBuffer ${o.byteLength} bytes>`;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(o);
    for (const k of keys.slice(0, MAX_ITEMS)) {
      try {
        out[k] = describe((o as Record<string, unknown>)[k], depth + 1);
      } catch (err) {
        out[k] = `[读取属性抛错: ${String(err)}]`;
      }
    }
    if (keys.length > MAX_ITEMS) out["…"] = `+${keys.length - MAX_ITEMS} more keys`;
    return out;
  };

  const json = (payload: Record<string, unknown>): string => {
    try {
      return JSON.stringify(payload);
    } catch (err) {
      return JSON.stringify({ ok: false, error: `结果序列化失败: ${String(err)}` });
    }
  };

  const finishOk = (value: unknown): string =>
    json({ ok: true, type: typeof value, value: describe(value, 0) });

  const finishErr = (err: unknown): string => {
    const e = (err ?? {}) as { name?: string; message?: string; stack?: string };
    const hint = /EvalError|unsafe-eval|Refused to evaluate/i.test(String(e.message ?? err))
      ? "(页面 CSP 禁止 eval;试试 world=isolated)"
      : "";
    return json({
      ok: false,
      error: `${e.name ?? "Error"}: ${e.message ?? String(err)}${hint}`,
      stack: clip(String(e.stack ?? "")),
    });
  };

  const run = async (): Promise<string> => {
    let ret: unknown;
    try {
      // 间接 eval:在页面全局作用域执行(可访问 window 上的变量/函数)
      ret = (0, eval)(code);
    } catch (err) {
      return finishErr(err);
    }
    if (!awaitResult) return finishOk(ret);
    try {
      return finishOk(await (ret as Promise<unknown>));
    } catch (err) {
      return finishErr(err);
    }
  };

  if (timeoutMs <= 0) return run();
  const timeout = new Promise<string>((resolve) =>
    setTimeout(() => resolve(finishErr(new Error(`页面内执行超时(${timeoutMs}ms)`))), timeoutMs),
  );
  return Promise.race([run(), timeout]);
}

// ---------- 网络抓包 ----------

export interface NetworkHookConfig {
  maxEntries: number; // 缓冲区条数上限(超出丢最旧)
  maxBody: number; // 单个 body 保留的最大字符数
}

export interface NetworkHookState {
  installed: boolean;
  reused: boolean;
  total: number;
  installedAt: number | null;
}

interface NetEntry {
  id: number;
  kind: "fetch" | "xhr";
  method: string;
  url: string;
  startTs: number;
  status: number | null;
  ok: boolean | null;
  durationMs: number | null;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  error?: string;
  note?: string;
}

interface NetState {
  version: number;
  installedAt: number;
  entries: NetEntry[];
  dropped: number;
  nextId: number;
  config: NetworkHookConfig;
}

// 安装 fetch / XMLHttpRequest 钩子(幂等)。抓到的请求存到页面全局 __browserBridgeNet,
// 由 readNetwork 读取。响应体用 resp.clone() 旁路读取,不改动页面拿到的对象,
// 因此 SSE(流式)也能逐块记录而不影响页面自己消费。
// force=true 时丢掉旧状态重建(修复被外部破坏/改掉的钩子,同时重置计数与缓冲区)。
export function installNetworkHook(cfg: NetworkHookConfig, force?: boolean): NetworkHookState {
  const G = globalThis as unknown as Record<string, unknown> & {
    __browserBridgeNet?: NetState;
    __browserBridgeXhrHooked?: boolean;
  };

  const prev = G.__browserBridgeNet;
  if (prev && prev.version === 1 && force !== true) {
    prev.config = cfg;
    return { installed: true, reused: true, total: prev.entries.length, installedAt: prev.installedAt };
  }
  if (force === true) {
    // 重建:旧闭包(旧 fetch 包装器)会继续写进旧数组,对读侧无影响
    delete G.__browserBridgeNet;
    delete G.__browserBridgeXhrHooked;
  }

  const entries: NetEntry[] = [];
  const state: NetState = {
    version: 1,
    installedAt: Date.now(),
    entries,
    dropped: 0,
    nextId: 1,
    config: { maxEntries: cfg.maxEntries, maxBody: cfg.maxBody },
  };
  G.__browserBridgeNet = state;

  const push = (e: NetEntry): void => {
    entries.push(e);
    while (entries.length > state.config.maxEntries) {
      entries.shift();
      state.dropped++;
    }
  };
  const clipText = (s: string): [string, boolean] =>
    s.length > state.config.maxBody ? [s.slice(0, state.config.maxBody), true] : [s, false];
  const headersToObject = (h: Headers | null | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    try {
      h?.forEach((v, k) => {
        out[k] = String(v);
      });
    } catch {
      // Headers 不可枚举时忽略
    }
    return out;
  };
  const parseRawHeaders = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of raw.trim().split(/[\r\n]+/)) {
      const i = line.indexOf(":");
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
  };

  // 旁路读取响应体:文本类记录内容(封顶),二进制只记类型
  const captureBody = (resp: Response, rec: NetEntry): void => {
    try {
      const ct = String(resp.headers?.get?.("content-type") ?? "");
      if (ct && !/json|text|xml|javascript|event-stream|x-ndjson|x-www-form-urlencoded/i.test(ct)) {
        rec.note = `二进制响应(${ct})`;
        return;
      }
      const clone = resp.clone();
      if (!clone.body || typeof clone.body.getReader !== "function") {
        void clone
          .text()
          .then((t) => {
            const [s, tr] = clipText(String(t));
            rec.responseBody = s;
            rec.responseBodyTruncated = tr;
          })
          .catch(() => {});
        return;
      }
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let truncated = false;
      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) return;
            if (!truncated) {
              text += decoder.decode(value as Uint8Array, { stream: true });
              if (text.length >= state.config.maxBody) {
                text = text.slice(0, state.config.maxBody);
                truncated = true;
              }
            }
            rec.responseBody = text;
            rec.responseBodyTruncated = truncated;
            pump();
          })
          .catch(() => {});
      };
      pump();
    } catch (err) {
      rec.note = `响应体捕获失败: ${String(err)}`;
    }
  };

  // --- fetch ---
  const origFetch = (G as { fetch?: typeof fetch }).fetch;
  if (typeof origFetch === "function") {
    const patched = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const started = performance.now();
      let rec: NetEntry | null = null;
      try {
        const isRequest = typeof Request !== "undefined" && input instanceof Request;
        const url = typeof input === "string" ? input : isRequest ? input.url : String((input as URL).href ?? input);
        const method = String(init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
        const requestHeaders: Record<string, string> = isRequest ? headersToObject(input.headers) : {};
        if (init?.headers) {
          try {
            new Headers(init.headers).forEach((v, k) => {
              requestHeaders[k] = String(v);
            });
          } catch {
            // headers 非标准结构时忽略
          }
        }
        let requestBody: string | undefined;
        let requestBodyTruncated: boolean | undefined;
        const body = init?.body;
        if (typeof body === "string") {
          [requestBody, requestBodyTruncated] = clipText(body);
        } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
          [requestBody, requestBodyTruncated] = clipText(String(body));
        }
        rec = {
          id: state.nextId++,
          kind: "fetch",
          method,
          url,
          startTs: Date.now(),
          status: null,
          ok: null,
          durationMs: null,
          requestHeaders,
          requestBody,
          requestBodyTruncated,
        };
        push(rec);
      } catch {
        rec = null;
      }
      const out = origFetch.apply(this, [input, init] as Parameters<typeof fetch>);
      if (rec === null || typeof out?.then !== "function") return out;
      const entry = rec;
      return out.then(
        (resp: Response) => {
          entry.status = resp.status;
          entry.ok = resp.ok;
          entry.durationMs = Math.round(performance.now() - started);
          entry.responseHeaders = headersToObject(resp.headers);
          captureBody(resp, entry);
          return resp;
        },
        (err: unknown) => {
          entry.error = String((err as Error)?.message ?? err);
          entry.durationMs = Math.round(performance.now() - started);
          throw err;
        },
      );
    };
    (G as { fetch?: unknown }).fetch = patched;
  }

  // --- XMLHttpRequest ---
  const XP = (globalThis as unknown as { XMLHttpRequest?: { prototype: XMLHttpRequest } }).XMLHttpRequest?.prototype;
  if (XP && !G.__browserBridgeXhrHooked) {
    type XhrTagged = XMLHttpRequest & {
      __bbReq?: { method: string; url: string; requestHeaders: Record<string, string> };
    };
    const origOpen = XP.open;
    const origSetHeader = XP.setRequestHeader;
    const origSend = XP.send;

    XP.open = function (this: XhrTagged, method: string, url: string | URL, ...rest: unknown[]): void {
      try {
        this.__bbReq = { method: String(method).toUpperCase(), url: String(url), requestHeaders: {} };
      } catch {
        // 记录失败不影响页面
      }
      return (origOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
    };
    XP.setRequestHeader = function (this: XhrTagged, name: string, value: string): void {
      try {
        const tagged = this as XhrTagged;
        if (tagged.__bbReq) tagged.__bbReq.requestHeaders[name.toLowerCase()] = String(value);
      } catch {
        // 忽略
      }
      return (origSetHeader as (...a: unknown[]) => void).apply(this, [name, value]);
    };
    XP.send = function (this: XhrTagged, body?: Document | XMLHttpRequestBodyInit | null): void {
      const meta = this.__bbReq ?? { method: "GET", url: "", requestHeaders: {} };
      const started = performance.now();
      const rec: NetEntry = {
        id: state.nextId++,
        kind: "xhr",
        method: meta.method,
        url: meta.url,
        startTs: Date.now(),
        status: null,
        ok: null,
        durationMs: null,
        requestHeaders: meta.requestHeaders,
      };
      if (typeof body === "string") {
        const [s, tr] = clipText(body);
        rec.requestBody = s;
        rec.requestBodyTruncated = tr;
      }
      push(rec);
      const xhr = this;
      const onDone = (): void => {
        try {
          rec.status = xhr.status;
          rec.durationMs = Math.round(performance.now() - started);
          rec.responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
          const rt = String(xhr.responseType || "");
          if (rt === "" || rt === "text") {
            const [s, tr] = clipText(String(xhr.responseText ?? ""));
            rec.responseBody = s;
            rec.responseBodyTruncated = tr;
          } else if (rt === "json") {
            try {
              const [s, tr] = clipText(JSON.stringify(xhr.response));
              rec.responseBody = s;
              rec.responseBodyTruncated = tr;
            } catch {
              rec.note = "JSON 响应序列化失败";
            }
          } else {
            rec.note = `responseType=${rt}`;
          }
        } catch {
          // 跨域等场景读不到,忽略
        }
      };
      try {
        xhr.addEventListener("loadend", onDone);
      } catch {
        // 忽略
      }
      return (origSend as (...a: unknown[]) => void).apply(this, [body]);
    };
    G.__browserBridgeXhrHooked = true;
  }

  return { installed: true, reused: false, total: 0, installedAt: state.installedAt };
}

export interface NetworkReadOptions {
  filter?: string;
  limit: number;
  includeBody: boolean;
  redact: boolean;
  sinceId?: number;
  maxBodyChars: number;
}

// 读取缓冲区(不改变缓冲区内容);redact=true 时掩掉凭据类 header 的值
//
// 自包含约束:本函数只被 chrome.scripting.executeScript 序列化函数本体后注入,
// 因此**所有**辅助(正则、清洗、截断)都必须定义在函数内部 —— 引用模块作用域的
// 变量/函数会直接 ReferenceError,症状是工具报"注入未返回可用结果"。
export function readNetwork(opts: NetworkReadOptions): NetworkReadView {
  const SECRET_HEADERS =
    /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
  // 保证返回值 JSON 安全:丢掉值为 undefined 的字段
  const sanitize = (value: unknown): NetworkReadView => JSON.parse(JSON.stringify(value)) as NetworkReadView;

  const state = (globalThis as unknown as { __browserBridgeNet?: NetState }).__browserBridgeNet;
  if (!state) {
    return sanitize({ installed: false, installedAt: null, total: 0, dropped: 0, nextId: 0, entries: [] });
  }

  const mask = (v: string): string =>
    v.length > 12 ? `${v.slice(0, 6)}…«redacted ${v.length} chars»` : "«redacted»";
  const headers = (h?: Record<string, string>): Record<string, string> | undefined => {
    if (!h) return undefined;
    if (!opts.redact) return { ...h };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADERS.test(k) ? mask(String(v)) : String(v);
    return out;
  };
  const trim = (s?: string): string | undefined =>
    typeof s === "string" && s.length > opts.maxBodyChars ? `${s.slice(0, opts.maxBodyChars)}…(截断)` : s;

  const selected = state.entries
    .filter(
      (e) =>
        (opts.sinceId === undefined || e.id > opts.sinceId) &&
        (!opts.filter || String(e.url).includes(opts.filter)),
    )
    .slice(-opts.limit)
    .map((e) => {
      const out: NetworkEntryView = {
        id: e.id,
        kind: e.kind,
        method: e.method,
        url: e.url,
        status: e.status,
        ok: e.ok,
        durationMs: e.durationMs,
        startTs: e.startTs,
      };
      // 注意:值为 undefined 的字段绝不能出现在返回值里 ——
      // chrome.scripting.executeScript 的返回值走 base::Value 转换,不支持 undefined,
      // 会把整个结果变成 null(症状:工具报"未返回数据")。只写实际有值的字段。
      if (e.requestHeaders) out.requestHeaders = headers(e.requestHeaders);
      if (e.responseHeaders) out.responseHeaders = headers(e.responseHeaders);
      if (e.error !== undefined) out.error = String(e.error);
      if (e.note !== undefined) out.note = String(e.note);
      if (opts.includeBody) {
        if (e.requestBody !== undefined) out.requestBody = trim(e.requestBody);
        if (e.responseBody !== undefined) out.responseBody = trim(e.responseBody);
        if (e.responseBodyTruncated !== undefined) out.responseBodyTruncated = e.responseBodyTruncated;
      }
      return out;
    });

  return sanitize({
    installed: true,
    installedAt: state.installedAt,
    total: state.entries.length,
    dropped: state.dropped,
    nextId: state.nextId,
    entries: selected,
  });
}

export function clearNetwork(): { installed: boolean; cleared: number } {
  const state = (globalThis as unknown as { __browserBridgeNet?: NetState }).__browserBridgeNet;
  if (!state) return { installed: false, cleared: 0 };
  const n = state.entries.length;
  state.entries.length = 0;
  state.dropped = 0;
  return { installed: true, cleared: n };
}

// ---------- WebMCP(页面经 document.modelContext 注册的工具) ----------

// 探测当前页面注册的 WebMCP 工具列表。按需注入的**纯只读**操作:
// 只调 getTools() 做快照,不注册工具、不加监听器、不写任何页面全局状态。
// 返回值 JSON 安全:RegisteredTool 里的 window/execute 不可序列化,丢弃;
// 每个工具单独容错,一个坏 schema 不影响整个列表。
export async function readWebMcpTools(): Promise<WebMcpProbeView> {
  const sanitize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const api =
    typeof document !== "undefined" && (document as Record<string, unknown>).modelContext
      ? "document.modelContext"
      : typeof navigator !== "undefined" && (navigator as Record<string, unknown>).modelContext
        ? "navigator.modelContext"
        : "";
  if (!api) {
    return sanitize({
      supported: false,
      api: "",
      tools: [],
      error: "页面未暴露 WebMCP API(需要 Chrome 146+ 并开启 WebMCP DevTrial/flag,且页面注册过工具)",
    });
  }

  const host =
    typeof document !== "undefined" && (document as Record<string, unknown>).modelContext
      ? document
      : (navigator as unknown as Record<string, unknown>);
  const mc = (host as unknown as { modelContext: { getTools: () => Promise<unknown[]> } }).modelContext;
  try {
    const raw = (await mc.getTools()) as Record<string, unknown>[];
    const tools: WebMcpToolView[] = [];
    for (const t of raw) {
      try {
        const view: WebMcpToolView = {
          name: String(t.name),
          description: String(t.description ?? ""),
        };
        if (typeof t.title === "string" && t.title) view.title = t.title;
        if (t.inputSchema !== undefined && t.inputSchema !== null) {
          // schema 可能含不可序列化结构,失败则丢弃该字段而不是丢掉整个工具;
          // 有的实现/页面把 schema 存成 JSON 字符串,先尝试 parse 回对象
          try {
            let schema: unknown = t.inputSchema;
            if (typeof schema === "string") schema = JSON.parse(schema);
            view.inputSchema = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
          } catch {
            /* 忽略不可解析的 schema */
          }
        }
        const ann = t.annotations as Record<string, unknown> | undefined;
        if (ann && typeof ann === "object") {
          const hints: NonNullable<WebMcpToolView["annotations"]> = {};
          if (ann.readOnlyHint === true) hints.readOnlyHint = true;
          if (ann.untrustedContentHint === true) hints.untrustedContentHint = true;
          if (ann.consequentialHint === true) hints.consequentialHint = true;
          if (Object.keys(hints).length > 0) view.annotations = hints;
        }
        if (typeof t.origin === "string" && t.origin) view.origin = t.origin;
        tools.push(view);
      } catch (err) {
        tools.push({ name: String((t as { name?: unknown })?.name ?? "(unnamed)"), description: `(工具信息读取失败: ${String(err)})` });
      }
    }
    tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return sanitize({ supported: true, api, tools });
  } catch (err) {
    return sanitize({
      supported: true,
      api,
      tools: [],
      error: `getTools() 失败: ${String((err as Error)?.message ?? err)}`,
    });
  }
}

// 调用页面注册的 WebMCP 工具。仍是按需注入:临时 getTools() 定位工具后
// executeTool() 一次,不缓存工具引用、不残留任何状态。
export async function callWebMcpTool(name: string, args: unknown, timeoutMs: number): Promise<WebMcpCallView> {
  const sanitize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const fail = (error: string, available?: string[]): WebMcpCallView =>
    sanitize({ ok: false, name, error, ...(available ? { available } : {}) });

  const mc = (typeof document !== "undefined" ? (document as Record<string, unknown>).modelContext : undefined) ??
    (typeof navigator !== "undefined" ? (navigator as Record<string, unknown>).modelContext : undefined);
  if (!mc) return fail("页面未暴露 WebMCP API(Chrome 146+ / flag)");

  const ctx = mc as { getTools: () => Promise<unknown[]>; executeTool: (t: unknown, input?: unknown, opts?: unknown) => Promise<unknown> };
  let tool: unknown;
  try {
    const tools = (await ctx.getTools()) as { name?: unknown }[];
    tool = tools.find((t) => t?.name === name);
    if (!tool) {
      return fail(`页面未注册工具 "${name}"`, tools.map((t) => String(t?.name ?? "?")).sort());
    }
  } catch (err) {
    return fail(`getTools() 失败: ${String((err as Error)?.message ?? err)}`);
  }

  const started = Date.now();
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  // 不能只靠 executeTool 响应 AbortSignal —— 实现可能忽略 signal 挂死,
  // 所以用 race 兜底保证本函数一定在 timeoutMs 后返回;abort 只是尽力协作取消。
  let raceTimer: ReturnType<typeof setTimeout> | null = null;
  const run = async (): Promise<unknown> => {
    const input = (args ?? {}) as object;
    try {
      // Chrome DevTrial 实测签名:executeTool(tool, inputJsonString),绑定层负责 parse
      return await ctx.executeTool(tool, JSON.stringify(input));
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // 绑定层 parse 失败发生在工具执行前(无副作用),按草案签名(对象直传)重试
      if (/parse input arguments/i.test(msg)) {
        return await ctx.executeTool(tool, input, ac ? { signal: ac.signal } : undefined);
      }
      throw err;
    }
  };
  try {
    const result = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        raceTimer = setTimeout(() => {
          ac?.abort();
          reject(new Error(`执行超时(${timeoutMs}ms)`));
        }, timeoutMs);
      }),
    ]) as unknown;
    // 工具(或 Chrome 绑定)常把结果包成 MCP 风格 {content:[{type:"text",...}], isError?}
    // 再整体字符串化:解出内层文本;isError:true 映射为 ok:false(工具级失败)
    let resultStr = String(result);
    let toolIsError = false;
    try {
      const parsed = JSON.parse(resultStr) as { content?: { text?: unknown }[]; isError?: unknown };
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.content)) {
        const texts = parsed.content
          .map((c) => (c && typeof c.text === "string" ? c.text : ""))
          .filter((s) => s.length > 0);
        if (texts.length > 0) {
          resultStr = texts.join("\n");
          toolIsError = parsed.isError === true;
        }
      }
    } catch {
      /* 非 JSON 结果,原样返回 */
    }
    return sanitize({
      ok: !toolIsError,
      name,
      ...(toolIsError ? { error: resultStr } : { result: resultStr }),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    return sanitize({
      ok: false,
      name,
      error: `工具执行失败: ${String((err as Error)?.message ?? err)}`,
      durationMs: Date.now() - started,
    });
  } finally {
    if (raceTimer !== null) clearTimeout(raceTimer);
  }
}
