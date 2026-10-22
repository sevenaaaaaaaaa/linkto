#!/bin/bash
# 重新编译 macOS SF Symbols 渲染器（AppKit 小工具）
# 产物 packaging/macos/sf-symbols 会被 electron-builder 放进 Contents/Resources/ 并签名。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build/swift-module-cache packaging/macos
xcrun swiftc -O -target arm64-apple-macos12.0 -module-cache-path .build/swift-module-cache packaging/macos/sf-symbols.swift -o packaging/macos/sf-symbols
echo "built packaging/macos/sf-symbols"
