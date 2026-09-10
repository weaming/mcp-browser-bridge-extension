# browser-bridge 构建与部署
#
#   make            # = make deploy:构建 host + 扩展,并同步到 Chrome 加载目录
#   make build      # 只构建(dist/browser-bridge-host + extension-dist/)
#   make deploy     # 构建 + rsync 扩展到 $(EXT_DIR)
#   make test       # bun test(含 mock 模式 MCP API 集成测试)
#   make typecheck  # tsc --noEmit
#   make pack       # 发布:全平台 zip(dist/release/*.zip)
#   make status     # 查看 host 的 MCP 端口
#
# 扩展是 unpacked 加载的,manifest 不变时更新 js 后由 Chrome 重启 service worker 生效;
# 改了 manifest(权限等)则需要在 chrome://extensions 点一次"重新加载"。

SHELL := /bin/bash
BUN ?= bun
EXT_DIR ?= $(HOME)/chrome/browser-bridge
PORT_FILE ?= $(HOME)/.browser-bridge/port
# host 实际监听的 MCP 端口(端口文件由 host 写入;没有文件时用默认 1234)
PORT ?= $(shell cat $(PORT_FILE) 2>/dev/null || echo 1234)
# 注册 native host 的目标浏览器(--chrome / --chromium / --edge / --all)
HOST_TARGET ?= --chrome

.PHONY: all setup build ext host deploy test typecheck pack reload status clean

all: deploy

build: ## 编译 host + 打包扩展
	$(BUN) run build

ext: ## 只打包扩展目录 extension-dist/
	$(BUN) run scripts/build.ts

test: ## 单元 + MCP API 集成测试(无需真浏览器)
	$(BUN) test

typecheck: ## 类型检查
	$(BUN) x tsc --noEmit

deploy: build ## 构建并同步扩展到 Chrome 加载目录
	@test -d "$(EXT_DIR)" || { echo "扩展目录不存在: $(EXT_DIR)(Chrome 里加载的路径,可用 EXT_DIR=... 覆盖)"; exit 1; }
	rsync -a --delete extension-dist/ "$(EXT_DIR)/"
	@echo "deployed → $(EXT_DIR)"

host: ## 注册 native messaging host(开发布局:指向 dist/browser-bridge-host)
	@bash ./scripts/install-host.sh $(HOST_TARGET)

setup: deploy host ## 首次安装:构建 host + 扩展 + 注册 host
	@echo "setup 完成:若浏览器已打开,扩展重载用 make reload,manifest 变更需在 chrome://extensions 点一次重新加载"

pack: ## 全平台发布包
	$(BUN) run scripts/build.ts --all

status: ## 查看 host MCP 端口
	@echo "MCP port: $(PORT)"

reload: ## 触发扩展重载(使磁盘上的新代码生效)
	@curl -sS --max-time 10 -X POST "http://127.0.0.1:$(PORT)/mcp" \
		-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
		-d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_reload_extension","arguments":{}}}' | head -c 400; echo

clean:
	rm -rf dist extension-dist
