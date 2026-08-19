// 构建 host、安装器与扩展。
// 用法:
//   bun run scripts/build.ts             # 当前平台 host + 扩展(本地开发)
//   bun run scripts/build.ts --all       # 发布:全部平台 zip(dist/release/*.zip)
//   BUILD_ALL=1 bun run scripts/build.ts # 同上

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const BUILD_ALL = process.env.BUILD_ALL === "1" || process.argv.includes("--all");

// 版本号:取自 package.json,用于发布包命名
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version as string;

// bun --compile 的交叉编译 target(平台-架构 → bun target)
const TARGETS: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "win32-x64": "bun-windows-x64",
};

const isWin = (plat: string) => plat === "win32-x64";
const ext = (plat: string) => (isWin(plat) ? ".exe" : "");

// 打包扩展目录(extension-dist)
async function buildExtension(): Promise<void> {
  if (!existsSync("extension/manifest.json")) return;
  const extDist = "extension-dist";
  rmSync(extDist, { recursive: true, force: true });
  mkdirSync(extDist, { recursive: true });

  await $`bun build ./extension/background.ts --outdir ${extDist} --target browser`;
  await $`bun build ./extension/content-script.ts --outdir ${extDist} --target browser`;
  await $`bun build ./extension/popup/popup.ts --outdir ${extDist}/popup --target browser`;
  await $`cp extension/manifest.json ${extDist}/manifest.json`;
  await $`cp extension/popup/popup.html ${extDist}/popup/popup.html`;
  await $`cp -r extension/icons ${extDist}/icons`;
}

// 当前平台 host(本地开发)
await $`bun build ./host/main.ts --compile --outfile dist/browser-bridge-host`;
await $`chmod +x dist/browser-bridge-host`;

if (BUILD_ALL) {
  await buildExtension();
  rmSync("dist/release", { recursive: true, force: true });

  for (const [plat, target] of Object.entries(TARGETS)) {
    const dir = `dist/release/${plat}`;
    mkdirSync(dir, { recursive: true });

    await $`bun build ./host/main.ts --compile --target ${target} --outfile ${dir}/browser-bridge-host${ext(plat)}`;
    if (!isWin(plat)) {
      await $`chmod +x ${dir}/browser-bridge-host`;
    }
    // 安装脚本(零依赖)+ 扩展目录放进平台包(一个 zip 全搞定)
    await $`cp scripts/install-host.sh ${dir}/install-host.sh`;
    await $`cp scripts/install-host.ps1 ${dir}/install-host.ps1`;
    await $`cp -r extension-dist ${dir}/browser-bridge`;
    await $`cd dist/release/${plat} && zip -qr ../browser-bridge-${VERSION}-${plat}.zip .`;
    console.log(`packed ${plat} [${target}] → browser-bridge-${VERSION}-${plat}.zip`);
  }
  console.log(`release zips: dist/release/browser-bridge-${VERSION}-*.zip`);
} else {
  await buildExtension();
  console.log("build ok: dist/browser-bridge-host + extension-dist/ (install scripts in scripts/)");
}
