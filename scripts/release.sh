#!/bin/bash
# Formal release for LinkTo: bump package.json -> commit `chore(release): vX.Y.Z` -> annotated tag
# -> build (mac dmg + win + linux) -> push -> GitHub Release marked Latest, notes from CHANGELOG.md.
#
# Usage: scripts/release.sh X.Y.Z [--dry-run] [--no-install]
#   X.Y.0 for a main version; X.Y.Z (Z>0) only for an urgent fix of a formal release.
#   --dry-run     validate + print the release notes, change nothing
#   --no-install  do not replace /Applications/LinkTo.app
#
# CHANGELOG.md must already contain the section: `## X.Y.0 — YYYY-MM-DD · 主题` for a main version,
# or the line `### X.Y.Z — YYYY-MM-DD  修复：…` for a patch. Re-running after a failure resumes
# (an existing release commit/tag on HEAD is reused; existing release assets are not clobbered).

set -euo pipefail

APP_NAME="LinkTo"
GH_REPO="sevenaaaaaaaaa/linkto"
BRANCH="main"
INSTALL_PATH="/Applications/${APP_NAME}.app"

VERSION=""
DRY_RUN=0
NO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-install) NO_INSTALL=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    v[0-9]*|[0-9]*) VERSION="${arg#v}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: scripts/release.sh X.Y.Z [--dry-run] [--no-install]" >&2; exit 2; }
TAG="v${VERSION}"

NVM_NODE_BIN="$(ls -d "${HOME}"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="${NVM_NODE_BIN:+${NVM_NODE_BIN}:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# ---------- 1. Release notes from CHANGELOG.md ----------
[ -f CHANGELOG.md ] || die "CHANGELOG.md not found"
notes_body="$(awk -v v="$VERSION" '
  BEGIN { esc = v; gsub(/\./, "\\.", esc) }
  # Main version: the whole "## X.Y.Z — …" section up to the next level-2 heading (patch lines excluded).
  $0 ~ "^## " esc " " { grab = 1; print; next }
  grab && /^## / { exit }
  grab && /^### / { exit }
  grab { print; next }
  # Patch: the single "### X.Y.Z — …" line.
  $0 ~ "^### " esc " " { print; exit }
' CHANGELOG.md)"
[ -n "$notes_body" ] || die "CHANGELOG.md has no '## ${VERSION} — …' section or '### ${VERSION} — …' line; write it first"
heading="$(printf '%s\n' "$notes_body" | head -1)"
theme="$(printf '%s' "$heading" | sed -n 's/.*· *//p')"
title="${APP_NAME} ${TAG}${theme:+ · ${theme}}"

notes_file="$(mktemp /tmp/linkto-release-notes.XXXXXX)"
trap 'rm -f "$notes_file"' EXIT
{
  printf '%s\n' "$notes_body" | sed '1s/^#\{2,3\} /## /'
  echo
  echo "## 下载与安装"
  echo
  echo "- macOS（Apple Silicon）：\`${APP_NAME}-${VERSION}-arm64.dmg\`"
  echo "- Windows 10/11（x64）：\`${APP_NAME}.Setup.${VERSION}.exe\`（未签名，SmartScreen 拦截时点「更多信息 → 仍要运行」）"
  echo "- Linux（x64）：\`${APP_NAME}-${VERSION}.AppImage\`（\`chmod +x\` 后运行）"
  echo
  echo "macOS 安装包未经 Apple 公证。若提示「已损坏，无法打开」，打开 DMG 后双击 \`打不开？双击我.command\`（详见 DMG 内 \`安装说明.txt\`），或在终端执行："
  echo
  echo '```'
  echo "xattr -dr com.apple.quarantine /Applications/${APP_NAME}.app && open /Applications/${APP_NAME}.app"
  echo '```'
} > "$notes_file"

log "release ${TAG}: ${title}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "----- release notes -----"; cat "$notes_file"; echo "-------------------------"
  log "dry-run: nothing changed"
  exit 0
fi

# ---------- 2. Preconditions ----------
for tool in git node npm gh; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "not on ${BRANCH}"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit CHANGELOG.md and everything else first"
git fetch --tags origin || die "git fetch failed"
[ "$(git rev-list --count "HEAD..origin/${BRANCH}")" -eq 0 ] || die "behind origin/${BRANCH}; pull first"

resume=0
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  [ "$(git rev-list -n 1 "$TAG")" = "$(git rev-parse HEAD)" ] || die "tag ${TAG} exists on another commit"
  resume=1
  log "tag ${TAG} already on HEAD -> resuming build/publish"
fi

[ -d node_modules ] || npm ci --no-audit --no-fund || die "npm ci failed"
npm run typecheck || die "typecheck failed"

# ---------- 3. Bump + commit + tag ----------
if [ "$resume" -eq 0 ]; then
  current="$(node -p "require('./package.json').version")"
  [ "$current" != "$VERSION" ] || die "package.json is already ${VERSION} but no tag exists; check the history"
  npm version "$VERSION" --no-git-tag-version >/dev/null || die "version bump failed"
  git add package.json package-lock.json
  git commit -m "chore(release): ${TAG}" || die "release commit failed"
  git tag -a "$TAG" -m "${title}" || die "tag failed"
  log "committed and tagged ${TAG} (was ${current})"
else
  [ "$(node -p "require('./package.json').version")" = "$VERSION" ] || die "package.json does not match ${TAG}"
fi

# ---------- 4. Build ----------
dmg="dist/${APP_NAME}-${VERSION}-arm64.dmg"
log "building: npm run dist…"
npm run dist || die "build failed (commit/tag stay local; fix and re-run to resume)"
[ -f "$dmg" ] || die "expected DMG not found: $dmg"
mnt="$(mktemp -d /tmp/linkto-dmg-check.XXXXXX)"
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null || die "cannot mount $dmg"
ok=1
for entry in "${APP_NAME}.app" "Applications" "打不开？双击我.command" "安装说明.txt"; do
  [ -e "$mnt/$entry" ] || { log "DMG missing entry: $entry"; ok=0; }
done
hdiutil detach "$mnt" >/dev/null || hdiutil detach -force "$mnt" >/dev/null || true
rmdir "$mnt" 2>/dev/null || true
[ "$ok" -eq 1 ] || die "DMG content check failed"

assets=("$dmg")
[ -f "dist/${APP_NAME}-${VERSION}.AppImage" ] && assets+=("dist/${APP_NAME}-${VERSION}.AppImage")
[ -f "dist/${APP_NAME} Setup ${VERSION}.exe" ] && assets+=("dist/${APP_NAME} Setup ${VERSION}.exe")

# ---------- 5. Push + GitHub Release ----------
git push origin "$BRANCH" || die "git push failed"
git push origin "$TAG" || die "git push tag failed"
if gh release view "$TAG" -R "$GH_REPO" >/dev/null 2>&1; then
  existing="$(gh release view "$TAG" -R "$GH_REPO" --json assets -q '.assets[].name')"
  for a in "${assets[@]}"; do
    name="$(basename "$a" | tr ' ' '.')"
    printf '%s\n' "$existing" | grep -qxF "$name" && { log "asset already on release, keeping: $name"; continue; }
    gh release upload "$TAG" "$a" -R "$GH_REPO" || die "upload failed: $a"
  done
else
  gh release create "$TAG" "${assets[@]}" -R "$GH_REPO" --verify-tag --title "$title" \
    --notes-file "$notes_file" --latest || die "gh release create failed"
fi
log "release: $(gh release view "$TAG" -R "$GH_REPO" --json url -q .url)"

# ---------- 6. Update the local app ----------
if [ "$NO_INSTALL" -eq 0 ]; then
  built_app="dist/mac-arm64/${APP_NAME}.app"
  [ -d "$built_app" ] || die "built app not found: $built_app"
  was_running=0
  if pgrep -xq "$APP_NAME"; then
    was_running=1
    osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do pgrep -xq "$APP_NAME" || break; sleep 1; done
  fi
  if pgrep -xq "$APP_NAME"; then
    log "WARN: ${APP_NAME} still running; not replacing ${INSTALL_PATH}"
  else
    staging="${INSTALL_PATH%.app}.new.app"
    rm -rf "$staging"
    ditto "$built_app" "$staging" || die "ditto failed"
    xattr -dr com.apple.quarantine "$staging" 2>/dev/null || true
    old=""
    if [ -d "$INSTALL_PATH" ]; then
      old="$(mktemp -d /tmp/linkto-old-app.XXXXXX)"
      mv "$INSTALL_PATH" "$old/" || die "cannot move old app aside"
    fi
    mv "$staging" "$INSTALL_PATH" || die "cannot move new app into place"
    [ -n "$old" ] && rm -rf "$old"
    log "installed ${INSTALL_PATH}"
    [ "$was_running" -eq 1 ] && { open "$INSTALL_PATH" || log "WARN: relaunch failed"; }
  fi
fi
log "==== done: ${APP_NAME} ${TAG}"
