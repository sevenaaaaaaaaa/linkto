#!/bin/bash
# 重新编译原生混合壳（NSToolbar addon，Electron 44 / arm64）
# 产物 native/macos-shell/linkto_shell.node 会随 app 打包并签名。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p .build/node-gyp
LINKTO_TARGET_ARCH="${LINKTO_TARGET_ARCH:-arm64}"
case "$LINKTO_TARGET_ARCH" in arm64|x64) ;; *) echo "Unsupported architecture: $LINKTO_TARGET_ARCH" >&2; exit 1 ;; esac
cd native/macos-shell
npm_config_devdir="$ROOT/.build/node-gyp" npx node-gyp rebuild \
  --target=44.6.0 --arch="$LINKTO_TARGET_ARCH" --dist-url=https://electronjs.org/headers
cp build/Release/linkto_shell.node ./linkto_shell.node
echo "built native/macos-shell/linkto_shell.node"
