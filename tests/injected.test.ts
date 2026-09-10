// 注入函数(extension/injected.ts)的测试:网络钩子捕获 fetch/流式响应/凭据打码,
// 以及页面内求值的序列化与超时。这些函数本身就是自包含的,bun 进程里可直接调。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import vm from "node:vm";
import { clearNetwork, evalInPage, installNetworkHook, readNetwork } from "../extension/injected";

const origFetch = globalThis.fetch;
const HOOK_CFG = { maxEntries: 50, maxBody: 500 };
let server: ReturnType<typeof Bun.serve>;

interface EvalPayload {
  ok: boolean;
  type?: string;
  value?: unknown;
  error?: string;
}

beforeAll(() => {
  installNetworkHook(HOOK_CFG);
  server = Bun.serve({
    port: 8899,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/sse") {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"a":1}\n\n'));
            controller.enqueue(enc.encode('data: {"b":2}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ ok: true, path: url.pathname });
    },
  });
});

afterAll(() => {
  globalThis.fetch = origFetch; // 还原,避免影响其它测试文件
  clearNetwork();
  server?.stop(true);
});

describe("网络钩子", () => {
  test("重复安装幂等(reused=true);force=true 可重建", () => {
    const again = installNetworkHook(HOOK_CFG);
    expect(again.installed).toBe(true);
    expect(again.reused).toBe(true);
    const forced = installNetworkHook(HOOK_CFG, true);
    expect(forced.reused).toBe(false); // 重建:丢掉旧状态与旧闭包
    expect(forced.total).toBe(0);
  });

  test("捕获 fetch 请求方法/状态/请求体/响应体", async () => {
    clearNetwork();
    const res = await fetch("http://127.0.0.1:8899/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    await res.json();
    await Bun.sleep(30); // 等旁路读 body 的分支读完

    const snap = readNetwork({ limit: 10, includeBody: true, redact: true, maxBodyChars: 2000 });
    const e = snap.entries.find((x) => x.url.includes("/api"));
    expect(e).toBeDefined();
    expect(e?.method).toBe("POST");
    expect(e?.status).toBe(200);
    expect(e?.ok).toBe(true);
    expect(e?.requestBody).toContain("hello");
    expect(e?.responseBody).toContain("ok");
    expect(e?.requestHeaders?.["content-type"]).toContain("application/json");
  });

  test("流式 SSE 逐块记录且不影响页面消费", async () => {
    clearNetwork();
    const res = await fetch("http://127.0.0.1:8899/sse");
    const text = await res.text(); // 页面侧完整消费
    expect(text).toContain('"a":1');
    expect(text).toContain('"b":2');
    await Bun.sleep(30);

    const snap = readNetwork({ limit: 10, includeBody: true, redact: true, maxBodyChars: 2000 });
    const e = snap.entries.find((x) => x.url.includes("/sse"));
    expect(e?.responseBody).toContain('"b":2');
  });

  test("凭据类 header 默认打码,redact=false 保留原值", async () => {
    clearNetwork();
    const token = "Bearer supersecrettoken123456";
    await (await fetch("http://127.0.0.1:8899/api", { headers: { authorization: token } })).json();

    const redacted = readNetwork({ limit: 5, includeBody: false, redact: true, maxBodyChars: 100 });
    const masked = redacted.entries.find((x) => x.url.includes("/api"));
    expect(masked?.requestHeaders?.authorization).toContain("redacted");
    expect(masked?.requestHeaders?.authorization).not.toContain("supersecrettoken");

    const raw = readNetwork({ filter: "/api", limit: 5, includeBody: false, redact: false, maxBodyChars: 100 });
    expect(raw.entries.at(-1)?.requestHeaders?.authorization).toBe(token);
  });

  test("include_body=false 时不返回 body", async () => {
    const snap = readNetwork({ limit: 5, includeBody: false, redact: true, maxBodyChars: 100 });
    expect(snap.entries.every((e) => e.responseBody === undefined)).toBe(true);
  });

  // 回归测试:返回值里只要有一个 undefined 字段,chrome.scripting.executeScript 的
  // base::Value 转换就会整个失败(返回 null),工具侧表现为"未返回数据"。
  test("返回值 JSON 安全:递归不含 undefined 字段", async () => {
    clearNetwork();
    await (await fetch("http://127.0.0.1:8899/api")).json(); // 一条无 error / 无 note 的记录
    const snap = readNetwork({ limit: 10, includeBody: true, redact: true, maxBodyChars: 100 });
    const bad: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (v === undefined) {
        bad.push(path);
        return;
      }
      if (v === null || typeof v !== "object") return;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, `${path}.${k}`);
    };
    walk(snap, "$");
    expect(bad).toEqual([]);
    expect(JSON.parse(JSON.stringify(snap)).entries.length).toBe(snap.entries.length);
  });

  test("filter 按 URL 子串过滤", async () => {
    clearNetwork();
    await (await fetch("http://127.0.0.1:8899/sse")).text(); // 制造 sse 记录
    await (await fetch("http://127.0.0.1:8899/api")).json(); // 制造 api 记录
    const snap = readNetwork({ filter: "/sse", limit: 10, includeBody: false, redact: true, maxBodyChars: 100 });
    expect(snap.entries.length).toBe(1);
    expect(snap.entries.every((e) => e.url.includes("/sse"))).toBe(true);
  });

  test("clear 清空缓冲区", async () => {
    expect(clearNetwork().cleared).toBeGreaterThan(0);
    const snap = readNetwork({ limit: 5, includeBody: false, redact: true, maxBodyChars: 100 });
    expect(snap.total).toBe(0);
  });

  test("未安装时 readNetwork 返回 installed=false", () => {
    const had = (globalThis as { __browserBridgeNet?: unknown }).__browserBridgeNet;
    delete (globalThis as { __browserBridgeNet?: unknown }).__browserBridgeNet;
    expect(readNetwork({ limit: 1, includeBody: false, redact: true, maxBodyChars: 10 }).installed).toBe(false);
    (globalThis as { __browserBridgeNet?: unknown }).__browserBridgeNet = had;
  });
});

describe("注入函数自包含", () => {
  // chrome.scripting.executeScript 只序列化函数本体,不带任何模块作用域。
  // 把函数源码放进一个只有全局对象的隔离上下文里调用,能真正拦住
  // "引用了模块作用域变量" 这类 bug(运行时症状:注入结果变成 null)。
  function isolatedCall<T>(fn: (...args: never[]) => unknown, code: string, seed: Record<string, unknown>): T {
    const sandbox: Record<string, unknown> = {
      console,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      performance,
      URL,
      Response,
      Request,
      WebAssembly,
      fetch: async () => new Response("{}"),
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox) as Record<string, unknown>;
    vm.runInContext(`globalThis.__fn = ${fn.toString()}`, ctx);
    for (const [k, v] of Object.entries(seed)) ctx[k] = v;
    return vm.runInContext(code, ctx) as T;
  }

  test("readNetwork 可用(含 header 打码与 body)", () => {
    const net = {
      version: 1,
      installedAt: Date.now(),
      dropped: 0,
      nextId: 2,
      config: { maxEntries: 10, maxBody: 50 },
      entries: [
        {
          id: 1,
          kind: "fetch",
          method: "POST",
          url: "https://x.test/y",
          startTs: 1,
          status: 200,
          ok: true,
          durationMs: 3,
          requestHeaders: { authorization: "Bearer secret-token-123456", "content-type": "application/json" },
          responseBody: '{"ok":true}',
        },
      ],
    };
    const out = isolatedCall<{ entries: { requestHeaders?: Record<string, string>; responseBody?: string }[] }>(
      readNetwork,
      "__fn({ limit: 5, includeBody: true, redact: true, maxBodyChars: 50 })",
      { __browserBridgeNet: net },
    );
    expect(out.entries.length).toBe(1);
    expect(out.entries[0].requestHeaders?.authorization).toContain("redacted");
    expect(out.entries[0].responseBody).toContain("ok");
  });

  test("readNetwork 无钩子时的分支", () => {
    const out = isolatedCall<{ installed: boolean }>(readNetwork, "__fn({ limit: 1, includeBody: false, redact: true, maxBodyChars: 10 })", {});
    expect(out.installed).toBe(false);
  });

  test("clearNetwork 可用", () => {
    const net = { version: 1, installedAt: 1, dropped: 0, nextId: 1, config: {}, entries: [{ id: 1 }] };
    const out = isolatedCall<{ installed: boolean; cleared: number }>(clearNetwork, "__fn()", { __browserBridgeNet: net });
    expect(out).toEqual({ installed: true, cleared: 1 });
  });

  test("installNetworkHook 可用", () => {
    const out = isolatedCall<{ installed: boolean }>(installNetworkHook, "__fn({ maxEntries: 5, maxBody: 50 })", {});
    expect(out.installed).toBe(true);
  });

  test("evalInPage 可用", async () => {
    const raw = await isolatedCall<Promise<string>>(evalInPage, "__fn('1+1', true, 1000)", {});
    expect(JSON.parse(raw).value).toBe(2);
  });
});

describe("页面内求值", () => {
  test("同步结果带类型", async () => {
    const r = JSON.parse(await evalInPage("1+1", true, 1000)) as EvalPayload;
    expect(r.ok).toBe(true);
    expect(r.type).toBe("number");
    expect(r.value).toBe(2);
  });

  test("await=true 解 promise", async () => {
    const r = JSON.parse(await evalInPage("Promise.resolve({a:[1,2,3]})", true, 1000)) as {
      value: { a: number[] };
    };
    expect(r.value.a).toEqual([1, 2, 3]);
  });

  test("await=false 不解 promise", async () => {
    const r = JSON.parse(await evalInPage("Promise.resolve(1)", false, 1000)) as EvalPayload;
    expect(r.type).toBe("object");
  });

  test("抛错返回错误与栈", async () => {
    const r = JSON.parse(await evalInPage("(()=>{throw new Error('boom')})()", true, 1000)) as EvalPayload;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
  });

  test("超时中断", async () => {
    const r = JSON.parse(await evalInPage("new Promise(()=>{})", true, 50)) as EvalPayload;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超时");
  });

  test("循环引用与函数被安全序列化", async () => {
    const r = JSON.parse(
      await evalInPage("(()=>{const o={fn(){return 1}};o.self=o;return o})()", true, 1000),
    ) as { value: Record<string, unknown> };
    expect(r.value.self).toBe("[Circular]");
    expect(String(r.value.fn)).toContain("[Function");
  });
});
