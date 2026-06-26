# ──────────────────────────────────────────────────────────────────────────
# claude-fleet — build an UNSIGNED Windows installer from Linux/WSL via Wine
#
# Quick start:
#   make wine        # one-time: install Wine + prerequisites (needs sudo)
#   make dist        # full pipeline -> dist/claude-fleet Setup <ver>.exe
#
# Other targets:
#   make windows     # (re)build the installer (assumes deps already installed)
#   make portable    # build a no-installer ZIP-able dir — does NOT need Wine
#   make help        # list all targets
#
# Why Wine is required: electron-builder packages the Windows app fine on Linux,
# but the NSIS target generates its uninstaller by *executing* the freshly built
# installer .exe — a Windows binary — which needs Wine. The `portable` target
# skips NSIS and therefore needs no Wine.
# ──────────────────────────────────────────────────────────────────────────

SHELL := /bin/bash
.DEFAULT_GOAL := help

WIN_ARCH ?= x64        # x64 | ia32 | arm64
DIST_DIR := dist

# Silence Wine's fixme/err spam during the build.
export WINEDEBUG := -all

.PHONY: help
help: ## List available targets
	@grep -E '^[a-zA-Z0-9_.-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

.PHONY: wine
wine: ## One-time: install Wine + prerequisites (Debian/Ubuntu, needs sudo)
	sudo dpkg --add-architecture i386
	sudo apt-get update
	sudo apt-get install -y --no-install-recommends \
		wine wine64 wine32:i386 mono-runtime
	@wine --version

.PHONY: doctor
doctor: ## Verify node, npm and wine are present
	@command -v node >/dev/null || { echo "✗ node not found"; exit 1; }
	@command -v npm  >/dev/null || { echo "✗ npm not found";  exit 1; }
	@command -v wine >/dev/null || { echo "✗ wine not found — run 'make wine'"; exit 1; }
	@echo "✓ node $$(node -v) | npm $$(npm -v) | $$(wine --version)"

.PHONY: install
install: ## Install JS deps WITHOUT compiling host (Linux) native modules
	# --ignore-scripts skips the postinstall that would compile native modules
	# for Linux (we cross-prepare the Windows ones in `natives-win`). We keep
	# OPTIONAL deps so Rollup's platform-native package stays installed.
	npm ci --ignore-scripts || npm install --ignore-scripts

.PHONY: natives-win
natives-win: ## Cross-prepare native modules (better-sqlite3, keytar, node-pty) for Windows
	# cpu-features (optional dep of ssh2 via dockerode) has no Windows prebuild
	# and only compiles from source — drop it; ssh2 runs fine without it.
	rm -rf node_modules/cpu-features
	# node-pty's install script keys off the HOST platform and would try to
	# compile on Linux. A stub host-prebuild dir makes `npm rebuild` a no-op so
	# its already-bundled win32-x64 prebuild is preserved untouched.
	mkdir -p node_modules/node-pty/prebuilds/linux-$(WIN_ARCH)
	# better-sqlite3 + keytar ship Windows prebuilts — electron-builder fetches
	# them for the Electron ABI.
	npx --no-install electron-builder install-app-deps \
		--platform win32 --arch $(WIN_ARCH)

.PHONY: build
build: ## Compile main/preload/renderer bundles (electron-vite)
	npm run build

.PHONY: windows
windows: build natives-win ## Build the unsigned Windows NSIS installer (needs Wine)
	npx --no-install electron-builder --win --$(WIN_ARCH) \
		--config electron-builder.yml \
		--publish never
	@echo "── Artifacts ──────────────────────────────"
	@ls -lh $(DIST_DIR)/*.exe 2>/dev/null || echo "(no .exe — check log above)"

.PHONY: portable
portable: build natives-win ## Build the app dir WITHOUT an installer (no Wine needed)
	npx --no-install electron-builder --win --$(WIN_ARCH) --dir \
		--config electron-builder.yml \
		-c.win.signAndEditExecutable=false \
		--publish never
	@echo "── Unpacked app at $(DIST_DIR)/win-unpacked (zip it to distribute) ──"

.PHONY: dist
dist: doctor install windows ## Full pipeline: doctor -> install -> Windows installer

.PHONY: clean
clean: ## Remove build outputs (out/, dist/)
	rm -rf out $(DIST_DIR)
