# Browser Bridge

**AI ↔ 浏览器控制桥**:把浏览器变成 MCP 工具集。任何 MCP 客户端(AI 程序)通过标准 MCP 协议调用 `browser_snapshot` / `browser_click` / `browser_type` 等工具,在真实浏览器里操作网页。

- 支持任意 MCP 客户端:Claude、codex、自定义 agent、curl
- 默认**跟随模式**:AI 自动控制你当前激活的标签页,零配置
- 真实浏览器,非 headless:登录态、验证码(提示你手动)、反爬特征自然

## 快速开始

### 1. 下载

从 [Releases](https://github.com/weaming/browser-bridge/releases) 下载**一个**压缩包:

- `browser-bridge-<platform>-<arch>.zip` — 按你机器的平台选

解压到任意目录(下文用 `<DIR>` 表示),目录内含 `browser-bridge/`(扩展)、`browser-bridge-host`、`install-host.sh`(Windows 为 `install-host.ps1`)。

### 2. 加载扩展

1. 打开 `chrome://extensions`
2. 右上角打开**开发者模式**
3. 点「加载已解压的扩展程序」,选择解压后的 `browser-bridge/` 目录

### 3. 安装 host

macOS / Linux:

```bash
cd <DIR>
./install-host.sh         # Windows(PowerShell): .\install-host.ps1
```

运行后会列出检测到的浏览器,回车安装到全部,或输入序号选特定浏览器;也支持参数直接指定:

```bash
./install-host.sh --all      # 安装到全部浏览器
./install-host.sh --chrome   # 只装 Chrome(--chromium / --edge 同理)
```

扩展 ID 已内置固定,无需手动填写;若你的扩展 ID 不同,可追加传参:`./install-host.sh <你的扩展ID>`。

> 若浏览器已打开,安装后请完全退出并重启浏览器。

### 4. 使用

任意 MCP 客户端连接:

```
MCP server: http://127.0.0.1:1234/mcp
```

端口被占时自动 +1,实际端口看扩展 popup(已连接 · MCP端口 xxxx)或 `~/.browser-bridge/port`。

codex 配置示例(`~/.codex/config.toml`):

```toml
[mcp_servers.browser]
url = "http://127.0.0.1:1234/mcp"
```

之后告诉 AI「帮我看看这个页面…」即可。

## MCP 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `browser_control_status` | — | 查询控制目标与连接状态 |
| `browser_list_tabs` | — | 列出所有标签页 |
| `browser_use_tab` | `tabId`(-1 回跟随) | 固定/切换控制目标 |
| `browser_new_tab` | `url?` | 新建标签页并立即跳转(缺省空白页) |
| `browser_close_tab` | `tabId?` | 关闭标签页(缺省关受控页,自动回跟随) |
| `browser_activate_tab` | `tabId` | 激活标签页给用户看,不改控制目标 |
| `browser_duplicate_tab` | `tabId?` | 复制标签页(缺省复制受控页) |
| `browser_pin_tab` | `tabId?`, `pinned?` | 固定/取消固定标签页 |
| `browser_snapshot` | — | 可交互元素快照(ref 编号+坐标) |
| `browser_extract` | `format?`(markdown\|html\|raw) | 提取正文;对话页(ChatGPT/Gemini)按问答轮次组装;format=html 返回净化 HTML,raw 返回原始 body HTML |
| `browser_screenshot` | — | 可视区截图(dataUrl,视觉理解复杂布局) |
| `browser_url` | — | 查询当前控制页 URL 与标题(轻量) |
| `browser_click` | `ref`, `button?` | 点击 |
| `browser_dblclick` | `ref` | 双击 |
| `browser_type` | `ref`, `text`, `clear?` | 输入(兼容 React 受控输入) |
| `browser_form_fill` | `fields[]` | 批量填写多个字段 |
| `browser_press` / `browser_key` | `key`, `modifiers?` | 按键(支持 ctrl/shift/alt/meta) |
| `browser_select` | `ref`, `value` | 下拉框 |
| `browser_scroll` | `dir`, `amount?`, `ref?` | 滚动 |
| `browser_hover` | `ref` | 悬停 |
| `browser_highlight` | `ref` | 高亮元素 1s(用户可见 AI 操作位置) |
| `browser_drag` | `fromRef`, `toRef` | HTML5 拖拽 |
| `browser_goto` | `url` | 跳转到指定 URL |
| `browser_back` | — | 浏览器后退 |
| `browser_refresh` | — | 刷新页面 |
| `browser_wait_for` | `ms` 或 `selector` 或 `text`(三选一,不可组合) | 等待:定时(ms≤60s),或等元素出现,或等页面文本出现(UI 条件最多 5s) |

AI 自行编排:snapshot → 决策 → 操作 → 再 snapshot,直到任务完成。

## 控制模式

- **跟随模式**(默认):控制你当前激活的标签页,切 tab 即切目标
- **固定模式**:锁定某个标签页(切换不跟随);popup 一键固定/取消,或 AI 调 `browser_use_tab`

工具栏图标徽标:无 = 跟随中;`AI` 琥珀 = 已固定;`!` 红 = 连接异常。

## 架构

```
任意 MCP 客户端
   │ MCP (Streamable HTTP, 127.0.0.1:1234/mcp)
browser-bridge host(单进程 = MCP ↔ 帧协议翻译器)
   │ native messaging(stdin/stdout 帧)
Chrome 扩展
   ├─ background:转发、目标解析、保活、状态徽标
   └─ content script:快照 / 执行
```

MV3 扩展无法监听端口,native host 是唯一通道(Chrome 官方 DevTools MCP 同构)。

## 从源码构建(开发者)

需要 [bun](https://bun.sh):

```bash
bun install
bun run build                    # 当前平台 host + 扩展
./scripts/install-host.sh        # 注册 host(默认内置扩展 ID)
bun run scripts/build.ts --all   # 交叉编译全部平台 + 发布包(发布用)
bun test                         # 单元 + MCP API 集成测试(无需浏览器)
```

## 配置

- `BROWSER_BRIDGE_PORT`:MCP 初始端口(默认 1234,被占自动 +1)
- `BROWSER_BRIDGE_MOCK=1`:模拟扩展应答(开发测试用)

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| popup 显示「host 未连接」 | 未安装 host / 浏览器未重启 | 运行 install-host,完全退出浏览器重开 |
| `Invalid native messaging host name` | host 名含连字符(旧版本) | 更新到新版(host 名 `com.browserbridge`) |
| 扩展 ID 不匹配 | 用旧版 manifest 加载 | 重新下载扩展,或 install-host 传参 `install-host.sh <你的ID>` |
| MCP 连不上 | host 未运行 | 先打开浏览器+扩展(host 由 Chrome 拉起) |
| 目标标签页不可达 | 页面未就绪/不是 http(s) | 等页面加载,或用 `browser_use_tab` 固定 |

## License

[MIT](LICENSE)
