import { describe, expect, test } from "bun:test";
import { addHeadingAnchors, normalizeMarkdown } from "../extension/extract";

describe("Markdown 清理", () => {
  test("收紧列表标记与内容之间的空格,保留嵌套层级", () => {
    const md = "*   一级\n    *   二级\n1.  有序项";

    expect(normalizeMarkdown(md)).toBe("* 一级\n    * 二级\n1. 有序项");
  });

  test("不修改代码围栏里的空格", () => {
    const md = "*   列表\n\n```text\n*   代码内容\n```";

    expect(normalizeMarkdown(md)).toBe("* 列表\n\n```text\n*   代码内容\n```");
  });

  test("移除嵌套列表中由转换器产生的空行", () => {
    const md = "*   一级\n    \n    *   二级\n    *   另一个二级\n    \n\n## 标题";

    expect(normalizeMarkdown(md)).toBe("* 一级\n    * 二级\n    * 另一个二级\n\n## 标题");
  });

  test("给 Markdown 标题补回原 HTML id,TOC 保持相对链接", () => {
    const md = "* [一级](#toc_0)\n\n## 一级\n\n### 二级";
    const anchors = [
      { id: "toc_0", text: "一级" },
      { id: "toc_1", text: "二级" },
    ];

    expect(addHeadingAnchors(md, anchors)).toBe(
      '* [一级](#toc_0)\n\n<a id="toc_0"></a>\n## 一级\n\n<a id="toc_1"></a>\n### 二级',
    );
  });

  test("不在代码围栏中插入标题锚点", () => {
    const md = "```md\n## 一级\n```\n\n## 一级";

    expect(addHeadingAnchors(md, [{ id: "toc_0", text: "一级" }])).toBe("```md\n## 一级\n```\n\n<a id=\"toc_0\"></a>\n## 一级");
  });
});
