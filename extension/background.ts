// background service worker:连接 native host(桥),
// 把 host 的帧请求转发到受控标签页的 content script,响应原路返回。
// 受控标签页由 popup 设置(set-target)。

import type {
  ContentRequest,
  ContentResponse,
  NativeRequest,
  NativeResponse,
  PopupRequest,
  PopupResponse,
} from "../shared/messages";

const HOST_NAME = "com.browserbridge";

let port: chrome.runtime.Port | null = null;
// 控制目标:null = 跟随模式(自动作用于当前激活标签页);非 null = 固定目标
let controlledTabId: number | null = null;
let lastError: string | null = null;
let mcpPort: number | null = null; // host 的 MCP 端口(供 popup 显示)
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000; // 重连退避:1s 起,翻倍至 10s

// 向 host 查询 MCP 端口
function queryPort(): void {
  if (!port) return;
  try {
    port.postMessage({ t: "get-port", seq: Date.now() } satisfies NativeRequest);
  } catch {
    // 连接损坏,下次重连再查
  }
}

// ---------- 状态徽标(工具栏图标,状态一眼可见) ----------

function updateBadge(): void {
  if (!port) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#ff6b6b" });
    return;
  }
  if (controlledTabId === null) {
    // 跟随模式:无徽标,保持透明(状态在 popup 里可看)
    chrome.action.setBadgeText({ text: "" });
  } else {
    chrome.action.setBadgeText({ text: "AI" });
    chrome.action.setBadgeBackgroundColor({ color: "#ffb454" });
  }
}

// 解析当前生效的控制目标:固定目标或(跟随模式)当前激活标签页
async function resolveTargetTabId(): Promise<number | null> {
  if (controlledTabId !== null) return controlledTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined && /^https?:\/\//.test(tab.url ?? "")) return tab.id;
  return null;
}

// 每个标签页只动态注入一次 content script(避免多实例竞争);
// 页面导航(loading)或关闭时清除记录,下次操作重新注入
const injectedTabs = new Set<number>();

async function ensureInjected(tabId: number): Promise<void> {
  if (injectedTabs.has(tabId)) return;
  await chrome.scripting
    .executeScript({ target: { tabId }, files: ["content-script.js"] })
    .catch(() => {});
  injectedTabs.add(tabId);
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") injectedTabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

// 设置控制目标:tabId=-1 取消固定(回跟随模式);否则固定并激活/注入。
// 返回错误信息(null=成功)。popup 与 host 帧两个入口共用。
async function setControlledTab(tabId: number): Promise<string | null> {
  if (tabId === -1) {
    controlledTabId = null;
    updateBadge();
    return null;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:\/\//.test(tab.url ?? "")) {
    return "标签页不存在或不是 http(s) 页面";
  }
  controlledTabId = tabId;
  updateBadge();
  // 激活目标标签页并聚焦窗口,让用户看到正在控制哪个页面
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  await ensureInjected(tabId);
  return null;
}

// 断线后立即安排重连(不等 alarm),失败时指数退避
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (port) return; // 已连上
    if (ensurePort()) {
      reconnectDelay = 1000; // 成功,重置退避
      lastError = null;
    } else {
      reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
      scheduleReconnect();
    }
  }, reconnectDelay);
}

function ensurePort(): boolean {
  if (port) return true;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    lastError = null;
  } catch (err) {
    lastError = `connectNative 失败: ${String(err)}`;
    port = null;
    updateBadge();
    return false;
  }
  port.onMessage.addListener((msg: NativeRequest | NativeResponse) => {
    // host 对查询的应答(扩展发起的 get-port 等)
    if (msg.t === "port-info") {
      mcpPort = msg.port;
      return;
    }
    void handleNative(msg as NativeRequest);
  });
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      lastError = `host 断开: ${chrome.runtime.lastError.message}`;
    }
    port = null;
    updateBadge();
    scheduleReconnect();
  });
  updateBadge();
  queryPort();
  return true;
}

async function handleNative(msg: NativeRequest): Promise<void> {
  if (msg.t === "ping") {
    port?.postMessage({ t: "pong" } satisfies NativeResponse);
    return;
  }
  if (msg.t === "list-tabs") {
    const tabs = await chrome.tabs.query({});
    const infos = tabs
      .filter((t) => t.id !== undefined && /^https?:\/\//.test(t.url ?? ""))
      .map((t) => ({
        id: t.id!,
        title: t.title ?? "",
        url: t.url ?? "",
        active: t.active === true,
        ...(t.pinned !== undefined ? { pinned: t.pinned } : {}),
      }));
    port?.postMessage({ t: "tabs", seq: msg.seq, tabs: infos } satisfies NativeResponse);
    return;
  }
  if (msg.t === "get-target") {
    const mode: "follow" | "fixed" = controlledTabId === null ? "follow" : "fixed";
    const tabId = await resolveTargetTabId();
    let target: { tabId: number; title: string; url: string } | null = null;
    if (tabId !== null) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t) target = { tabId: t.id!, title: t.title ?? "", url: t.url ?? "" };
    }
    port?.postMessage({
      t: "target-info",
      seq: msg.seq,
      target,
      connected: port !== null,
      mode,
    } satisfies NativeResponse);
    return;
  }
  if (msg.t === "set-target") {
    const err = await setControlledTab(msg.tabId);
    port?.postMessage({
      t: "set-target-result",
      seq: msg.seq,
      ok: err === null,
      message: err ?? (msg.tabId === -1 ? "已切换为跟随模式(控制当前激活标签页)" : `目标已更新`),
    } satisfies NativeResponse);
    return;
  }
  if (msg.t === "new-tab") {
    const tab = await chrome.tabs.create({ url: msg.url || undefined, active: true }).catch(() => null);
    if (!tab) {
      port?.postMessage({ t: "new-tab-result", seq: msg.seq, ok: false, message: "创建标签页失败" } satisfies NativeResponse);
      return;
    }
    port?.postMessage({
      t: "new-tab-result",
      seq: msg.seq,
      ok: true,
      tabId: tab.id,
      title: tab.title ?? "",
      url: tab.url ?? "",
    } satisfies NativeResponse);
    return;
  }
  if (msg.t === "activate-tab") {
    const ok = await chrome.tabs
      .update(msg.tabId, { active: true })
      .then(() => true)
      .catch(() => false);
    port?.postMessage({
      t: "activate-tab-result",
      seq: msg.seq,
      ok,
      ...(ok ? {} : { message: "标签页不存在" }),
    } satisfies NativeResponse);
    return;
  }
  if (msg.t === "duplicate-tab") {
    const tabId = msg.tabId ?? (await resolveTargetTabId());
    const tab = tabId === null ? null : await chrome.tabs.duplicate(tabId).catch(() => null);
    if (!tab) {
      port?.postMessage({ t: "duplicate-tab-result", seq: msg.seq, ok: false, message: "复制标签页失败" } satisfies NativeResponse);
      return;
    }
    port?.postMessage({ t: "duplicate-tab-result", seq: msg.seq, ok: true, tabId: tab.id } satisfies NativeResponse);
    return;
  }
  if (msg.t === "pin-tab") {
    const tabId = msg.tabId ?? (await resolveTargetTabId());
    const ok = tabId === null ? false : await chrome.tabs.update(tabId, { pinned: msg.pinned }).then(() => true).catch(() => false);
    port?.postMessage({
      t: "pin-tab-result",
      seq: msg.seq,
      ok,
      ...(ok ? {} : { message: "标签页不存在" }),
    } satisfies NativeResponse);
    return;
  }
  if (msg.t === "screenshot") {
    const result = await captureScreenshot();
    port?.postMessage({ t: "screenshot-result", seq: msg.seq, ...result } satisfies NativeResponse);
    return;
  }
  if (msg.t === "close-tab") {
    const tabId = msg.tabId ?? (await resolveTargetTabId());
    if (tabId === null) {
      port?.postMessage({
        t: "close-tab-result",
        seq: msg.seq,
        ok: false,
        message: "没有可关闭的标签页",
      } satisfies NativeResponse);
      return;
    }
    const ok = await chrome.tabs
      .remove(tabId)
      .then(() => true)
      .catch(() => false);
    port?.postMessage({
      t: "close-tab-result",
      seq: msg.seq,
      ok,
      ...(ok ? {} : { message: "标签页不存在或无法关闭" }),
    } satisfies NativeResponse);
    return;
  }
  const targetTabId = await resolveTargetTabId();
  if (targetTabId === null) {
    port?.postMessage({
      t: "error",
      seq: msg.seq,
      message: "没有可控制的标签页:当前激活标签页需是 http/https 页面,或用 browser_use_tab 固定目标",
    } satisfies NativeResponse);
    return;
  }
  await ensureInjected(targetTabId);
  let contentResp: ContentResponse | null = null;
  if (msg.t === "snapshot") {
    const req: ContentRequest = { kind: "snapshot", seq: msg.seq };
    contentResp = await chrome.tabs.sendMessage(targetTabId, req).catch(() => null);
  } else if (msg.t === "extract") {
    const req: ContentRequest = { kind: "extract", seq: msg.seq, format: msg.format };
    contentResp = await chrome.tabs.sendMessage(targetTabId, req).catch(() => null);
  } else if (msg.t === "execute") {
    const req: ContentRequest = { kind: "execute", seq: msg.seq, action: msg.action };
    contentResp = await chrome.tabs.sendMessage(targetTabId, req).catch(() => null);
  }
  if (contentResp === null) {
    port?.postMessage({ t: "error", seq: msg.seq, message: "目标标签页不可达(已关闭或页面未就绪)" } satisfies NativeResponse);
    return;
  }
  if (contentResp.kind === "snapshot") {
    port?.postMessage({
      t: "snapshot",
      seq: contentResp.seq,
      url: contentResp.url,
      title: contentResp.title,
      snapshot: contentResp.snapshot,
    } satisfies NativeResponse);
  } else if (contentResp.kind === "snapshot-error") {
    port?.postMessage({
      t: "snapshot-error",
      seq: contentResp.seq,
      code: contentResp.code,
      message: contentResp.message,
    } satisfies NativeResponse);
  } else if (contentResp.kind === "extract-result") {
    port?.postMessage({
      t: "extract-result",
      seq: contentResp.seq,
      ok: contentResp.ok,
      url: contentResp.url,
      title: contentResp.title,
      content: contentResp.content,
      fallback: contentResp.fallback,
      message: contentResp.message,
    } satisfies NativeResponse);
  } else {
    port?.postMessage({
      t: "execute-result",
      seq: contentResp.seq,
      ok: contentResp.ok,
      code: contentResp.code,
      detail: contentResp.detail,
    } satisfies NativeResponse);
  }
}

// ---------- 截图(captureVisibleTab → OffscreenCanvas 压缩 JPEG) ----------

async function captureScreenshot(): Promise<{ ok: boolean; dataUrl?: string; message?: string }> {
  const tabId = await resolveTargetTabId();
  if (tabId === null) return { ok: false, message: "没有可控制的标签页" };
  // 截图需要目标页处于激活状态
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  const png = await (chrome.tabs.captureVisibleTab as unknown as (opts: { format: string }) => Promise<string>)({ format: "png" }).catch(() => null);
  if (!png) return { ok: false, message: "截图失败(页面不可见?)" };
  try {
    // 压缩:缩放宽 1280 + JPEG 0.7,控制在 1MB 帧上限内
    const blob = await (await fetch(png)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 1280 / bitmap.width);
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(new Error("blob 转 dataURL 失败"));
      fr.readAsDataURL(out);
    });
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, message: `截图压缩失败: ${String(err)}` };
  }
}

// ---------- 受控标签页关闭时自动清理目标 ----------

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === controlledTabId) {
    controlledTabId = null;
    updateBadge();
    lastError = "受控标签页已关闭,已回到跟随模式(控制当前激活标签页)";
  }
});

// ---------- SW 保活 ----------
// MV3 service worker 空闲约 30s 会休眠,休眠会导致 native port 断开、
// host 进程被 Chrome 杀掉。用 alarm 周期性唤醒,保持 port 与 host 常驻。

const KEEPALIVE_ALARM = "keepalive";

// MV3 SW 是懒加载的:重载后 SW 不运行,alarm 也不会被注册,
// 导致 host 永不自动启动。onInstalled(重载视为 update)会唤醒 SW,确保 alarm 重建。
function ensureKeepalive(): void {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(ensureKeepalive);
chrome.runtime.onStartup.addListener(ensureKeepalive);
ensureKeepalive();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // 唤醒后确保 host 连接;连不上(host 被杀)则重连
  if (!port) {
    ensurePort();
  } else {
    try {
      port.postMessage({ t: "ping" });
    } catch {
      // 连接已损坏,下次 ensurePort 重建
    }
  }
});

// ---------- popup 消息 ----------

chrome.runtime.onMessage.addListener((msg: PopupRequest, _sender, sendResponse) => {
  const ok = ensurePort();
  if (msg.kind === "set-target") {
    void (async () => {
      const err = await setControlledTab(msg.tabId);
      if (err) lastError = err;
      sendResponse({
        kind: "status",
        connected: port !== null,
        error: lastError,
        target: null,
        mode: controlledTabId === null ? "follow" : "fixed",
      } satisfies PopupResponse);
    })();
  } else if (msg.kind === "get-status") {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = await resolveTargetTabId();
      let target: { tabId: number; title: string; url: string } | null = null;
      if (tabId !== null) {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (t) target = { tabId: t.id!, title: t.title ?? "", url: t.url ?? "" };
      }
      sendResponse({
        kind: "status",
        connected: port !== null,
        error: lastError,
        target,
        mode: controlledTabId === null ? "follow" : "fixed",
        port: mcpPort,
        tab: tab ? { id: tab.id!, title: tab.title ?? "", url: tab.url ?? "" } : undefined,
      } satisfies PopupResponse);
    })();
  }
  return true;
});
