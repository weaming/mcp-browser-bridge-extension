// 正文提取:普通文章页走 Readability;对话站(ChatGPT/Gemini/Google AI 模式)Readability 会丢弃对话轮次,
// 按站点规则直接组装 Markdown,仅复用库的 htmlToMarkdown。

import { extract, htmlToMarkdown } from "@weaming/readability-markdown";
import type { ContentResponse, ExtractFormat } from "../shared/messages";

const MAX_EXTRACT_CHARS = 100_000;
const MAX_RAW_CHARS = 1_000_000;

// 操作按钮、图标、读屏文本、引用来源角标等界面噪音
const NOISE_SELECTOR = [
  "button",
  "svg",
  "textarea",
  "[aria-hidden]",
  "[role=\"dialog\"]",
  "[popover]",
  "[style*=\"display: none\"]",
  "[data-container-id=\"rhs-col\"]",
  ".sr-only",
  ".cdk-visually-hidden",
  ".P8PNlb",
  "sup",
  "source-inline-chip",
  "source-footnote",
  "sources-carousel-inline",
  "response-element",
].join(", ");

const LINE_BLOCK_TAG = /^(P|DIV|LI)$/;

function okResult(content: string, opts: { title?: string; fallback?: boolean } = {}): ContentResponse {
  return {
    kind: "extract-result",
    seq: 0,
    ok: true,
    url: location.href,
    title: opts.title ?? document.title,
    content,
    ...(opts.fallback ? { fallback: true } : {}),
  };
}

// ---------- 代码块归一化 ----------

// ChatGPT 等站点代码块是 <pre><div><div><p>语言标签</p></div><div data-language="x"><p>每行</p></div></div>,
// 直接 textContent 会丢换行、语言标签文本泄漏进正文,提取前转成标准 pre>code
function normalizeEditorBlocks(doc: Document): void {
  for (const pre of [...doc.querySelectorAll("pre")]) {
    if (pre.querySelector(":scope > code")) continue;
    let editor = pre.querySelector<HTMLElement>("[data-language], [role='textbox']");
    if (!editor) {
      if (blockLines(pre).length < 2) continue;
      editor = pre;
    }
    // 编辑器前面的兄弟 div 通常是语言标签(如 "JSON"),移除避免泄漏
    if (editor !== pre) {
      const wrapper = editor.parentElement;
      const label = wrapper?.firstElementChild;
      if (wrapper && label !== editor && label?.textContent?.trim()) label.remove();
    }
    const lang = editor.getAttribute("data-language") ?? "";
    const code = doc.createElement("code");
    if (lang) {
      code.className = `language-${lang}`;
      code.setAttribute("data-language", lang);
    }
    // 每行一个 <p>/<div>,textContent 拼接会丢换行,逐行拼
    const lines = blockLines(editor).map((el) => el.textContent ?? "");
    code.textContent = (lines.length ? lines : [editor.textContent ?? ""]).join("\n");
    pre.replaceChildren(code);
  }
}

function blockLines(el: HTMLElement): HTMLElement[] {
  return [...el.children].filter((c): c is HTMLElement => LINE_BLOCK_TAG.test(c.tagName));
}

// ---------- 对话页规则 ----------

interface ChatMessage {
  el: HTMLElement;
  isUser: boolean;
}

interface ChatRule {
  headingLevel?: 1 | 2; // 提问/回答标题层级,默认 2
  match?: () => boolean; // 同源不同页面类型时额外校验,返回 false 跳过
  messages: (doc: Document) => ChatMessage[];
}

const CHAT_RULES: Record<string, ChatRule> = {
  "https://chatgpt.com": {
    messages: (doc) =>
      [...doc.querySelectorAll<HTMLElement>("[data-message-author-role]")].map((el) => ({
        el,
        isUser: el.getAttribute("data-message-author-role") === "user",
      })),
  },
  "https://gemini.google.com": {
    headingLevel: 1,
    messages: (doc) =>
      // querySelectorAll 分别查询会丢交叉顺序,按 DOM 位置重排
      domOrder([
        ...query(doc, "user-query-content .query-text", true),
        ...query(doc, "message-content div.md-content", false),
      ]),
  },
  "https://www.google.com": {
    headingLevel: 1,
    match: () => !!document.querySelector('div.CKgc1d[data-scope-id="turn"]'),
    messages: (doc) => {
      const msgs: ChatMessage[] = [];
      for (const turn of doc.querySelectorAll<HTMLElement>('div.CKgc1d[data-scope-id="turn"]')) {
        const heading = turn.querySelector<HTMLElement>("h2.iMqumd");
        if (heading) {
          const text = (heading.textContent ?? "").replace(/^您说[：:]\s*/, "").trim();
          if (text) {
            const span = doc.createElement("span");
            span.textContent = text;
            msgs.push({ el: span, isUser: true });
          }
        }
        const answer = turn.querySelector<HTMLElement>('[data-subtree="aimc"]');
        if (answer) {
          const clone = answer.cloneNode(true) as HTMLElement;
          const chips = [...clone.querySelectorAll<HTMLElement>("span[role='button']")];
          if (chips.length) {
            if (chips[0].closest("li")) {
              for (const chip of chips) chip.replaceWith(doc.createTextNode(chip.textContent ?? ""));
            } else {
              const ul = doc.createElement("ul");
              for (const chip of chips) {
                const li = doc.createElement("li");
                li.textContent = chip.textContent ?? "";
                ul.appendChild(li);
              }
              chips[0].replaceWith(ul);
              for (let i = 1; i < chips.length; i++) chips[i].remove();
            }
          }
          msgs.push({ el: clone, isUser: false });
        }
      }
      return msgs;
    },
  },
};

function query(doc: Document, selector: string, isUser: boolean): ChatMessage[] {
  return [...doc.querySelectorAll<HTMLElement>(selector)].map((el) => ({ el, isUser }));
}

function domOrder(messages: ChatMessage[]): ChatMessage[] {
  return messages.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// 每轮组装为 提问/回答 标题节,连续同角色消息合并为一节(保持问答交替);
// 历史未完全加载时允许首节为孤立的回答
function buildChatExtract(): ContentResponse | null {
  const rule = CHAT_RULES[location.origin];
  if (!rule) return null;
  if (rule.match && !rule.match()) return null;

  const doc = document.cloneNode(true) as Document;
  normalizeEditorBlocks(doc);

  const heading = "#".repeat(rule.headingLevel ?? 2);
  const sections: string[] = [];
  let lastIsUser: boolean | null = null;
  for (const { el, isUser } of rule.messages(doc)) {
    for (const noise of el.querySelectorAll(NOISE_SELECTOR)) noise.remove();
    const body = isUser
      ? (el.textContent ?? "").replace(/\s+/g, " ").trim()
      : cleanAnswerMd(htmlToMarkdown(el.innerHTML)).trim();
    if (!body) continue;
    if (lastIsUser === isUser) {
      sections[sections.length - 1] += `\n\n${body}`;
    } else {
      sections.push(`${heading} ${isUser ? "提问" : "回答"}\n\n${body}`);
      lastIsUser = isUser;
    }
  }
  if (!sections.length) return null;
  return okResult(sections.join("\n\n").slice(0, MAX_EXTRACT_CHARS));
}

// ---------- Markdown 清理 ----------

// turndown 在列表内会把围栏代码块整体缩进(顶格恢复,保留块内相对缩进);
// 标题行不会触发列表/强调等语法,去掉多余转义(如 "2\. xxx")
function cleanAnswerMd(md: string): string {
  return collapseListBlanks(cleanLines(md))
    .join("\n")
    .replace(/\\\*\\\*/g, "**")
    .replace(/^(\d+)\\\. /gm, "$1. ")
    .replace(/^(\w+)\n+(\n```)\n/gm, "$2$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLines(md: string): string[] {
  const lines = md.split("\n");
  let inFence = false;
  let fenceIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const m = /^(\s*)```/.exec(line);
      if (m) {
        inFence = true;
        fenceIndent = m[1].length;
        lines[i] = line.slice(fenceIndent);
      } else if (/^#{1,6} /.test(line)) {
        lines[i] = line.replace(/\\(.)/g, "$1");
      } else if (/^#{1,6}[^\s#]/.test(line)) {
        lines[i] = line.replace(/^(#{1,6})(?=[^\s#])/, "$1 ");
      } else {
        lines[i] = line.trimStart().replace(/^((?:[-*+]|\d{1,9}[.)]))\s{2,}/, "$1 ");
      }
      continue;
    }
    if (fenceIndent > 0) {
      lines[i] = line.startsWith(" ".repeat(fenceIndent)) ? line.slice(fenceIndent) : line.trimStart();
    }
    if (/^```/.test(lines[i])) inFence = false;
  }
  return lines;
}

// 相邻列表项之间的空行去掉,松散列表收紧为紧凑列表
function collapseListBlanks(lines: string[]): string[] {
  const isListCtx = (line: string) => /^\s*([-*+]|\d{1,9}[.)]) /.test(line);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const prev = out[out.length - 1];
      if (prev !== undefined && lines[j] !== undefined && isListCtx(prev) && isListCtx(lines[j])) {
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out;
}

// ---------- 入口 ----------

export function buildExtract(format: ExtractFormat = "markdown"): ContentResponse {
  if (format === "raw") {
    // 原始 body HTML,用于分析页面 DOM 结构
    return okResult((document.body?.innerHTML ?? "").slice(0, MAX_RAW_CHARS));
  }
  const chat = buildChatExtract();
  if (chat) return chat;
  const doc = document.cloneNode(true) as Document;
  normalizeEditorBlocks(doc);
  try {
    const article = extract(doc, { format });
    return okResult(article.content.slice(0, MAX_EXTRACT_CHARS), { title: article.title });
  } catch {
    // 非文章型页面(SPA/列表页)Readability 提取失败,回退整页 body 转 Markdown
    const md = htmlToMarkdown(document.body?.innerHTML ?? "");
    return okResult(md.slice(0, MAX_EXTRACT_CHARS), { fallback: true });
  }
}
