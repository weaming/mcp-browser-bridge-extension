// 注册 native messaging host:写入 Chrome 的 NativeMessagingHosts 清单。
// 用法: bun run scripts/install-host.ts <扩展ID>
//   扩展 ID 在 chrome://extensions 里该扩展的卡片上复制(32 位小写字母)。
//   或 BROWSER_BRIDGE_EXTENSION_ID=<id> bun run scripts/install-host.ts
// 注意:Chrome 要求 manifest 的 allowed_origins 精确匹配扩展 ID,否则扩展无法连接 host。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOST_NAME = "com.browserbridge";

const extId = process.env.BROWSER_BRIDGE_EXTENSION_ID ?? process.argv[2];
if (!extId) {
  console.error("缺少扩展 ID。请从 chrome://extensions 复制本扩展的 ID(32 位小写字母),然后:\n");
  console.error("  bun run scripts/install-host.ts <扩展ID>");
  console.error("或");
  console.error("  BROWSER_BRIDGE_EXTENSION_ID=<扩展ID> bun run scripts/install-host.ts");
  process.exit(1);
}
if (!/^[a-p]{32}$/.test(extId)) {
  console.error(`扩展 ID 格式非法: "${extId}"(应为 32 位 a-p 字母,如 abcdefghijklmnopabcdefghijklmnop)`);
  process.exit(1);
}

const hostPath = resolve("dist/browser-bridge-host");
if (!existsSync(hostPath)) {
  console.error("dist/browser-bridge-host 不存在,先运行 bun run build");
  process.exit(1);
}

const manifest = {
  name: HOST_NAME,
  description: "Browser Bridge native host (AI | program ↔ browser)",
  path: hostPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extId}/`],
};

const destDir = join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
const dest = join(destDir, `${HOST_NAME}.json`);
await Bun.write(dest, JSON.stringify(manifest, null, 2) + "\n");
console.log(`installed: ${dest}\n-> ${hostPath}\n-> allowed extension: ${extId}`);
console.log("若 Chrome 已打开,请完全退出并重启 Chrome 后再试。");
