#!/bin/bash
# Gatekeeper helper shipped inside the LinkTo DMG.
# Removes the com.apple.quarantine attribute from LinkTo.app so an unsigned /
# un-notarized build can launch instead of showing "已损坏，无法打开".
# No network access, no changes outside the app bundle.

set -u

APP_NAME="LinkTo"
APP_BUNDLE="${APP_NAME}.app"

say() { printf '%s\n' "$*"; }
pause_exit() {
  say ""
  read -r -p "按回车键关闭此窗口…" _ || true
  exit "${1:-0}"
}

say "=============================================="
say "  ${APP_NAME} 打开助手（解除 macOS「已损坏」提示）"
say "=============================================="
say ""

# Locate the app: /Applications first, then next to this script (inside the DMG).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH=""
for candidate in "/Applications/${APP_BUNDLE}" "${HOME}/Applications/${APP_BUNDLE}" "${SCRIPT_DIR}/${APP_BUNDLE}"; do
  if [ -d "$candidate" ]; then
    APP_PATH="$candidate"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  say "没有找到 ${APP_BUNDLE}。"
  say "请先把 ${APP_BUNDLE} 拖进「应用程序」(Applications) 文件夹，再双击本脚本。"
  pause_exit 1
fi

case "$APP_PATH" in
  /Volumes/*)
    say "提示：当前使用的是安装盘(DMG)里的 ${APP_BUNDLE}。"
    say "建议先把它拖进「应用程序」文件夹后再运行本脚本，否则每次都要从安装盘打开。"
    say ""
    ;;
esac

say "找到应用：$APP_PATH"
say ""
say "第 1 步：移除下载隔离标记（com.apple.quarantine）…"

if xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null; then
  say "  完成。"
else
  case "$APP_PATH" in
    /Volumes/*)
      say "  安装盘是只读的，无法在这里修改。请把 ${APP_BUNDLE} 拖进「应用程序」后再试。"
      pause_exit 1
      ;;
  esac
  say "  当前用户没有权限修改该应用（它可能是由其他用户/管理员安装的）。"
  say "  接下来会使用 sudo，只执行这一条命令："
  say "    xattr -dr com.apple.quarantine \"$APP_PATH\""
  say "  请输入本机登录密码（输入时不会显示字符）："
  if ! sudo xattr -dr com.apple.quarantine "$APP_PATH"; then
    say "  仍然失败。请参考安装说明.txt 中的手动方法。"
    pause_exit 1
  fi
  say "  完成。"
fi

say ""
say "第 2 步：检查应用签名完整性…"
if codesign --verify --deep "$APP_PATH" >/dev/null 2>&1; then
  say "  签名校验通过，无需处理。"
else
  say "  签名校验未通过，进行本地临时签名（ad-hoc，仅影响本机这份应用）…"
  if codesign --force --deep -s - "$APP_PATH" >/dev/null 2>&1; then
    say "  完成。"
  else
    say "  本地签名失败（可能缺少写权限），尝试 sudo…"
    if sudo codesign --force --deep -s - "$APP_PATH"; then
      say "  完成。"
    else
      say "  本地签名仍失败，将直接尝试打开应用。"
    fi
  fi
fi

say ""
say "第 3 步：打开 ${APP_NAME}…"
if open "$APP_PATH"; then
  say "  已启动。以后直接从「应用程序」或启动台打开即可，无需再运行本脚本。"
  pause_exit 0
else
  say "  打开失败。请在「系统设置 → 隐私与安全性」底部点击「仍要打开」后重试。"
  pause_exit 1
fi
