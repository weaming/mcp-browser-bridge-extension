// popup 逻辑:桥状态 + 控制目标 + 模式切换(跟随/固定)。

import type { PopupRequest, PopupResponse } from "../../shared/messages";

const BRAND_MARK_SVG = `
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <rect x="16" y="58" width="96" height="12" rx="6" fill="#FFB454"/>
  <circle cx="26" cy="64" r="12" fill="#7DD3FC"/>
  <circle cx="102" cy="64" r="12" fill="#FDE68A"/>
</svg>`;

const connEl = document.getElementById("conn") as HTMLDivElement;
const connTextEl = document.getElementById("conn-text") as HTMLSpanElement;
const modeBadgeEl = document.getElementById("mode-badge") as HTMLSpanElement;
const targetBoxEl = document.getElementById("target-box") as HTMLDivElement;
const modeBtnEl = document.getElementById("mode-btn") as HTMLButtonElement;
const noticeEl = document.getElementById("notice") as HTMLDivElement;

document.getElementById("brand-mark")!.innerHTML = BRAND_MARK_SVG;

type Target = { tabId: number; title: string; url: string };

let mode: "follow" | "fixed" = "follow";
let target: Target | null = null;

function faviconLetter(title: string, url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")[0]?.toUpperCase() ?? "?";
  } catch {
    return "?";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function notice(text: string | null): void {
  noticeEl.hidden = !text;
  if (text) noticeEl.textContent = text;
}

function setBridgeState(connected: boolean, port?: number | null): void {
  connEl.classList.toggle("on", connected);
  connTextEl.textContent = connected ? (port ? `已连接 · MCP端口 ${port}` : "已连接") : "未连接";
}

function renderTarget(): void {
  modeBadgeEl.className = "mode-badge " + mode;
  modeBadgeEl.textContent = mode === "follow" ? "跟随当前标签页" : "已固定";

  if (target) {
    // 默认只显示域名;悬停显示完整 URL(超长省略)
    const fullUrl = target.url.length > 300 ? target.url.slice(0, 300) + "…" : target.url;
    targetBoxEl.innerHTML = `
      <div class="favicon">${faviconLetter(target.title, target.url)}</div>
      <div style="min-width:0">
        <div class="target-title">${escapeHtml(target.title || "(无标题)")}</div>
        <div class="target-url" title="${escapeHtml(fullUrl)}">${escapeHtml(hostOf(target.url))}</div>
      </div>`;
  } else {
    targetBoxEl.innerHTML = `
      <div class="target-empty">没有可控制的标签页(需 http/https 页面)</div>`;
  }

  modeBtnEl.hidden = false;
  if (mode === "follow") {
    modeBtnEl.textContent = "📌 固定当前标签页";
    modeBtnEl.onclick = () => {
      if (target) setTarget(target.tabId);
    };
  } else {
    modeBtnEl.textContent = "↩ 回到跟随模式";
    modeBtnEl.onclick = () => setTarget(-1);
  }
}

function setTarget(tabId: number): void {
  chrome.runtime.sendMessage({ kind: "set-target", tabId } satisfies PopupRequest, (resp: PopupResponse) => {
    if (resp.kind === "status" && resp.error) notice(resp.error);
    refresh();
  });
}

function refresh(): void {
  chrome.runtime.sendMessage({ kind: "get-status" } satisfies PopupRequest, (resp: PopupResponse) => {
    if (resp.kind !== "status") return;
    setBridgeState(resp.connected, resp.port);
    mode = resp.mode ?? "follow";
    target = resp.target ?? null;
    if (resp.error) notice(resp.error);
    else notice(null);
    renderTarget();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

refresh();
// 目标可能被 AI 侧切换,保持新鲜
setInterval(refresh, 3000);
