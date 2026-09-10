#!/usr/bin/env bash
# 注册 Browser Bridge native messaging host(macOS / Linux)。
# 用法: ./install-host.sh [--all|--chrome|--chromium|--edge] [扩展ID]
#   --all / --chrome / --chromium / --edge  指定安装目标(默认交互选择,回车=全部)
#   扩展ID  覆盖默认固定 ID(一般不需要)
set -eo pipefail # 注意:不用 -u,兼容 macOS 自带 bash 3.2 的空数组展开

DEFAULT_EXT_ID="hjilgpmhomhbimplmicadchhdfnndmpg"
HOST_NAME="com.browserbridge"

SELECT=""
EXT_ID="$DEFAULT_EXT_ID"
for arg in "$@"; do
  case "$arg" in
    --all) SELECT="all" ;;
    --chrome) SELECT="chrome" ;;
    --chromium) SELECT="chromium" ;;
    --edge) SELECT="edge" ;;
    --*) echo "未知参数: $arg"; exit 1 ;;
    *) EXT_ID="$arg" ;;
  esac
done

if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "扩展 ID 格式非法: $EXT_ID(应为 32 位 a-p 字母)"
  exit 1
fi

# host 与脚本同目录(发布包布局);开发仓库里 host 在 ../dist/(build.ts 的产物)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$SCRIPT_DIR/browser-bridge-host"
if [ ! -f "$HOST_PATH" ]; then
  if [ -f "$SCRIPT_DIR/../dist/browser-bridge-host" ]; then
    HOST_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/dist/browser-bridge-host"
  else
    echo "找不到 $HOST_PATH(应与脚本在同一目录,或开发仓库的 ../dist/browser-bridge-host)"
    exit 1
  fi
fi

# 各浏览器候选目录
case "$(uname)" in
  Darwin)
    DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    )
    ;;
  Linux)
    DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Windows 请使用 install-host.ps1"
    exit 1
    ;;
esac

# 只保留实际存在的浏览器目录
FOUND=()
for d in "${DIRS[@]}"; do
  [ -d "$d" ] && FOUND+=("$d")
done
if [ ${#FOUND[@]} -eq 0 ]; then
  echo "未找到任何浏览器配置目录,请先安装并运行一次 Chrome/Edge/Chromium"
  exit 1
fi

# 确定安装目标
case "$SELECT" in
  all)
    SELECTED=("${FOUND[@]}")
    ;;
  chrome|chromium|edge)
    SELECTED=()
    for d in "${FOUND[@]}"; do
      case "$d" in *"$SELECT"*) SELECTED+=("$d") ;; esac
    done
    ;;
  *)
    if [ -t 0 ]; then
      echo "检测到浏览器目录:"
      for i in "${!FOUND[@]}"; do echo "  [$((i + 1))] ${FOUND[$i]}"; done
      echo "回车安装到全部,或输入序号(逗号分隔,如 1,3):"
      read -r answer
      SELECTED=()
      if [ -n "$answer" ]; then
        IFS=',' read -ra nums <<< "$answer"
        for n in "${nums[@]}"; do
          n="$(echo "$n" | tr -d ' ')"
          if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le "${#FOUND[@]}" ]; then
            SELECTED+=("${FOUND[$((n - 1))]}")
          fi
        done
      fi
      if [ ${#SELECTED[@]} -eq 0 ]; then SELECTED=("${FOUND[@]}"); fi
    else
      SELECTED=("${FOUND[@]}")
    fi
    ;;
esac

# 写入 manifest
MANIFEST=$(mktemp)
cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Browser Bridge native host (AI|program ↔ browser)",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
for d in "${SELECTED[@]}"; do
  mkdir -p "$d"
  cp "$MANIFEST" "$d/$HOST_NAME.json"
  echo "installed: $d/$HOST_NAME.json"
done
rm -f "$MANIFEST"

echo "host: $HOST_PATH"
echo "allowed extension: $EXT_ID"
echo "若浏览器已打开,请完全退出并重启后再试。"
