// 从 SVG 生成扩展图标 PNG(16/32/48/128)到 extension/icons 与 extension-dist/icons。
// 用法: bun run scripts/icons.ts

import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SIZES = [16, 32, 48, 128];
const svg = readFileSync("extension/icons/icon.svg", "utf8");

for (const size of SIZES) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = resvg.render().asPng();
  for (const dir of ["extension/icons", "extension-dist/icons"]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/icon-${size}.png`, png);
  }
  console.log(`icon-${size}.png ${png.length} bytes`);
}
console.log("icons generated");
