#!/usr/bin/env fish
# 本地一键安装:构建 host → 复制扩展到 ~/chrome/browser-bridge → 注册 Chrome host。
# 用法: fish scripts/setup-local.fish

set script_dir (dirname (status --current-filename))
cd "$script_dir/.."

echo "==> 构建 host 与扩展"
bun run scripts/build.ts
or exit 1

echo "==> 复制扩展到 ~/chrome/browser-bridge/"
rm -rf "$HOME/chrome/browser-bridge"
mkdir -p "$HOME/chrome"
cp -r extension-dist "$HOME/chrome/browser-bridge"

echo "==> 注册 host 到 Chrome"
set host_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.browserbridge.json"
mkdir -p (dirname "$host_manifest")
set host_path (realpath dist/browser-bridge-host)
set ext_id "hjilgpmhomhbimplmicadchhdfnndmpg"

printf '%s\n' \
    '{' \
    '  "name": "com.browserbridge",' \
    '  "description": "Browser Bridge native host (AI|program ↔ browser)",' \
    "  \"path\": \"$host_path\"," \
    '  "type": "stdio",' \
    "  \"allowed_origins\": [\"chrome-extension://$ext_id/\"]" \
    '}' > "$host_manifest"

echo "完成:"
echo "  扩展: $HOME/chrome/browser-bridge (chrome://extensions → 加载已解压的扩展程序)"
echo "  host: $host_manifest"
echo "提示:若浏览器已打开,请完全退出并重启后生效"
