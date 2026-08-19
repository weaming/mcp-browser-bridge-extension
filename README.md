# browser-bridge

**AI | 程序 ↔ 浏览器 控制桥**:把浏览器变成 MCP 工具集。任意 MCP 客户端(AI 程序)通过 MCP 协议调用 `browser_snapshot`/`browser_click`/`browser_type` 等工具,指令经 native messaging 转发给 Chrome 扩展在页面上执行。

## 架构

```
任意 MCP 客户端(Claude / codex / 自定义 agent ...)
   │ MCP (Streamable HTTP, 127.0.0.1:8790/mcp)
browser-bridge host(单个进程 = MCP 协议 ↔ 帧协议的翻译器)
   │ native messaging 帧
Chrome 扩展 (MV3)
   ├─ background : 转发 host 请求到受控标签页
   └─ content script : 抓快照(ref 编号) / 执行指令
```

- 扩展无法直接监听端口提供 MCP(MV3 无 TCP 能力),native host 是必需通道
- host 一个进程同时担任:原生消息 host + MCP server
- `BROWSER_BRIDGE_MOCK=1` 时帧请求内部模拟应答,无 Chrome 也可测试 MCP API

## MCP 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `browser_snapshot` | — | 可交互元素快照(带 ref 编号与坐标) |
| `browser_click` | `ref`, `button?` | 点击元素 |
| `browser_type` | `ref`, `text`, `clear?` | 输入文本(兼容 React 受控输入) |
| `browser_press` | `key`(Enter/Escape/Tab/ArrowDown/ArrowUp) | 按键 |
| `browser_select` | `ref`, `value` | 设置下拉框 |
| `browser_scroll` | `dir`, `amount?`, `ref?` | 滚动视口/元素 |
| `browser_hover` | `ref` | 悬停(触发 hover 菜单) |
| `browser_goto` | `url`(仅 http/https) | 跳转 |
| `browser_back` / `browser_refresh` | — | 后退 / 刷新 |
| `browser_wait` | `ms?`(默认 800) | 等待页面稳定 |

AI 自行编排:snapshot → 决策 → 执行 → 再 snapshot,直到任务完成。

## 构建与安装

```bash
bun install
bun run build          # 编译 host + 打包扩展到 extension-dist/
bun run install-host <扩展ID>  # 注册 native messaging host(扩展 ID 在 chrome://extensions 复制)
```

Chrome 打开 `chrome://extensions`,开发者模式 → 加载已解压的扩展 → 选择 `extension-dist/`。

使用:在目标标签页点扩展图标 →「🎯 控制此标签页」。之后任意 MCP 客户端连接即可控制该页面。

## 接入 MCP 客户端

MCP server 地址:初始 `http://127.0.0.1:1234/mcp`(Streamable HTTP)。端口被占时自动 +1 探测,实际端口写在 `~/.browser-bridge/port`(客户端读此文件发现端口)。

codex 配置示例(`~/.codex/config.toml`):

```toml
[mcp_servers.browser]
url = "http://127.0.0.1:8790/mcp"
```

注意 host 由 Chrome 管理生命周期:先开浏览器+扩展,再让 MCP 客户端连接。

## 环境变量

- `BROWSER_BRIDGE_PORT`:MCP HTTP 初始端口(默认 1234,被占自动 +1,最多试 20 个)
- `BROWSER_BRIDGE_MOCK=1`:模拟扩展应答(开发/测试用)

## 测试

```bash
bun test
```

单元测试覆盖帧协议与动作参数校验;集成测试以 mock 模式启动 host,通过 HTTP 验证 MCP 协议全链路(initialize/tools/list/工具调用)。
