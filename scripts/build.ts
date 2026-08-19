// 构建 host(--compile 单文件可执行)与扩展(打包到 extension-dist/)。
// 用法: bun run scripts/build.ts

import { $ } from "bun";
import { existsSync, mkdirSync, rmSync } from "node:fs";

await $`bun build ./host/main.ts --compile --outfile dist/browser-bridge-host`;
await $`chmod +x dist/browser-bridge-host`;

const extDist = "extension-dist";
if (existsSync("extension/manifest.json")) {
  rmSync(extDist, { recursive: true, force: true });
  mkdirSync(extDist, { recursive: true });

  await $`bun build ./extension/background.ts --outdir ${extDist} --target browser`;
  await $`bun build ./extension/content-script.ts --outdir ${extDist} --target browser`;
  await $`bun build ./extension/popup/popup.ts --outdir ${extDist}/popup --target browser`;
  await $`cp extension/manifest.json ${extDist}/manifest.json`;
  await $`cp extension/popup/popup.html ${extDist}/popup/popup.html`;
  await $`cp -r extension/icons ${extDist}/icons`;
}

console.log("build ok: dist/browser-bridge-host" + (existsSync("extension/manifest.json") ? " + extension-dist/" : ""));
