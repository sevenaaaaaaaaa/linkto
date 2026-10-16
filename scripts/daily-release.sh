#!/bin/bash
# Nightly build for LinkTo: sync -> typecheck -> build (mac dmg + win + linux) with an injected
# nightly version -> move the `nightly` tag -> refresh the single GitHub pre-release `nightly`
# -> update /Applications/LinkTo.app.
#
# Usage: scripts/daily-release.sh [--dry-run] [--no-install] [--force]
#   --dry-run     build + package locally only (no tag/push/release/install)
#   --no-install  do not replace /Applications/LinkTo.app
#   --force       build even if the `nightly` tag already points at HEAD
#
# Nothing is ever committed: the version source (package.json) stays at the last formal release;
# the nightly version `<next minor>-nightly.YYYYMMDD` (e.g. 0.4.0-nightly.20261014, which sorts above
# every 0.3.x and below the formal 0.4.0) is injected into the build only. Formal releases: scripts/release.sh.
#
# Safe for unattended runs: no prompts; exits 0 when skipped. The last line of output is always one of
#   RESULT: built nightly <version> <shortsha> | RESULT: skipped <reason> | RESULT: failed <reason>
# (parsed by ~/.local/bin/daily-release-all.sh).

set -euo pipefail

APP_NAME="LinkTo"
GH_REPO="sevenaaaaaaaaa/linkto"
BRANCH="main"
NIGHTLY_TAG="nightly"
LOG_FILE="${HOME}/Library/Logs/linkto-daily-release.log"
INSTALL_PATH="/Applications/${APP_NAME}.app"
LOCK_DIR="${TMPDIR:-/tmp}/linkto-daily-release.lock"

DRY_RUN=0
NO_INSTALL=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; echo "RESULT: failed unknown flag $arg"; exit 2 ;;
  esac
done

# launchd starts with a minimal PATH; add the usual tool locations (nvm node, Homebrew gh).
NVM_NODE_BIN="$(ls -d "${HOME}"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="${NVM_NODE_BIN:+${NVM_NODE_BIN}:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Exactly one RESULT line, always last. die/skip/finish set it; the EXIT trap prints it.
RESULT=""
FAIL_REASON="unexpected error"
on_exit() {
  local rc=$?
  [ "${HAVE_LOCK:-0}" -eq 1 ] && rm -rf "$LOCK_DIR"
  if [ -z "$RESULT" ]; then
    if [ "$rc" -eq 0 ]; then RESULT="skipped no result recorded"; else RESULT="failed ${FAIL_REASON} (rc=${rc})"; fi
  fi
  echo "RESULT: ${RESULT}"
}
trap on_exit EXIT
die() { log "ERROR: $*"; FAIL_REASON="$*"; RESULT="failed $*"; exit 1; }
skip() { log "SKIPPED: $*"; RESULT="skipped $*"; exit 0; }

# ---------- 0. Single instance ----------
HAVE_LOCK=0
if mkdir "$LOCK_DIR" 2>/dev/null; then
  HAVE_LOCK=1; echo $$ > "$LOCK_DIR/pid"
else
  other="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    skip "another run is in progress (pid ${other})"
  fi
  log "removing stale lock (pid ${other:-?})"
  rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" && HAVE_LOCK=1 && echo $$ > "$LOCK_DIR/pid" || die "cannot take lock $LOCK_DIR"
fi

log "==== ${APP_NAME} nightly start (dry-run=${DRY_RUN} no-install=${NO_INSTALL} force=${FORCE}) in ${REPO_ROOT}"

for tool in git node npm; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done
if [ "$DRY_RUN" -eq 0 ]; then
  command -v gh >/dev/null || die "missing tool: gh"
  gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
fi

# ---------- 1. Preconditions: main, clean, synced, typecheck ----------
current_branch="$(git rev-parse --abbrev-ref HEAD)"
dirty="$(git status --porcelain)"

if [ "$DRY_RUN" -eq 1 ]; then
  [ "$current_branch" = "$BRANCH" ] || log "WARN: on branch '${current_branch}', not '${BRANCH}' (dry-run continues)"
  [ -z "$dirty" ] || { log "WARN: working tree is dirty (dry-run continues):"; printf '%s\n' "$dirty"; }
else
  [ "$current_branch" = "$BRANCH" ] || skip "not on '${BRANCH}' (on '${current_branch}')"
  if [ -n "$dirty" ]; then
    log "working tree has uncommitted changes, not building (never auto-committing WIP):"
    printf '%s\n' "$dirty"
    skip "dirty working tree"
  fi
fi

log "fetching origin…"
# --force: the nightly tag is moved on every build, so the local copy must follow the remote.
if ! git fetch --tags --force origin; then
  [ "$DRY_RUN" -eq 1 ] || die "git fetch failed"
  log "WARN: git fetch failed (offline?); dry-run continues with local refs"
fi
behind="$(git rev-list --count "HEAD..origin/${BRANCH}")"
ahead="$(git rev-list --count "origin/${BRANCH}..HEAD")"
log "local vs origin/${BRANCH}: ahead=${ahead} behind=${behind}"
if [ "$behind" -gt 0 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    log "WARN: behind origin by ${behind} commit(s); dry-run does not pull"
  else
    log "pulling (rebase, autostash)…"
    if ! git pull --rebase --autostash origin "$BRANCH"; then
      git rebase --abort >/dev/null 2>&1 || true
      die "git pull --rebase failed (conflict or blocked); aborted, nothing forced — resolve manually"
    fi
    ahead="$(git rev-list --count "origin/${BRANCH}..HEAD")"
  fi
fi
if [ "$ahead" -gt 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  # A nightly must be reproducible from origin/main; pushing main is the developer's call.
  skip "local ${BRANCH} is ${ahead} commit(s) ahead of origin — push first"
fi

log "running checks: npm run typecheck"
[ -d node_modules ] || npm ci --no-audit --no-fund || die "npm ci failed"
npm run typecheck || die "typecheck failed"

# ---------- 2. Anything new since the last nightly? ----------
head_sha="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short HEAD)"
nightly_sha="$(git rev-list -n 1 "refs/tags/${NIGHTLY_TAG}" 2>/dev/null || true)"
log "HEAD ${short_sha}; ${NIGHTLY_TAG} tag -> ${nightly_sha:-<none>}"

if [ "$DRY_RUN" -eq 0 ] && [ "$FORCE" -eq 0 ] && [ "$nightly_sha" = "$head_sha" ]; then
  # Resume support: the tag may have moved while the release update failed. The notes carry a
  # marker with the built commit; only skip when the published release really is for HEAD.
  body="$(gh release view "$NIGHTLY_TAG" -R "$GH_REPO" --json body -q .body 2>/dev/null || true)"
  if printf '%s' "$body" | grep -qF "nightly-sha: ${head_sha}"; then
    skip "no new commits since the last nightly (${short_sha})"
  fi
  log "nightly tag is on HEAD but the release is incomplete -> resuming"
fi

# ---------- 3. Version (injected into the build only, never committed) ----------
base_version="$(node -p "require('./package.json').version")"
next_version="$(node -e '
  const [maj, min] = process.argv[1].split("-")[0].split(".").map(Number);
  console.log(`${maj}.${min + 1}.0`);' "$base_version")"
build_date="$(date +%Y%m%d)"
display_date="$(date +%Y-%m-%d)"
version="${next_version}-nightly.${build_date}"
log "version: package.json ${base_version} -> nightly ${version}"

# ---------- 4. Build ----------
# Drop older nightly artifacts so dist/ does not grow forever (formal builds are kept).
find dist -maxdepth 1 -name "*-nightly.*" -exec rm -rf {} + 2>/dev/null || true

dmg="dist/${APP_NAME}-${version}-arm64.dmg"
build_start=$(date +%s)
log "building: electron-vite build + electron-builder -mwl (mac dmg + win nsis + linux AppImage)…"
./node_modules/.bin/electron-vite build || die "electron-vite build failed"
# extraMetadata.version -> packaged package.json (app.getVersion()) and artifact names.
# Numeric-only fields (CFBundleShortVersionString/CFBundleVersion, Windows FileVersion) get the plain next version.
./node_modules/.bin/electron-builder -mwl \
  "-c.extraMetadata.version=${version}" \
  "-c.buildVersion=${next_version}" \
  "-c.mac.bundleShortVersion=${next_version}" \
  || die "electron-builder failed"
log "build finished in $(( $(date +%s) - build_start ))s"
[ -f "$dmg" ] || die "expected DMG not found: $dmg"
[ -z "$(git status --porcelain)" ] || [ "$DRY_RUN" -eq 1 ] || die "build left the working tree dirty"

# Sanity check: the DMG must contain the Gatekeeper helper.
mnt="$(mktemp -d /tmp/linkto-dmg-check.XXXXXX)"
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null || die "cannot mount $dmg"
helper_ok=1
for entry in "${APP_NAME}.app" "Applications" "打不开？双击我.command" "安装说明.txt"; do
  [ -e "$mnt/$entry" ] || { log "DMG missing entry: $entry"; helper_ok=0; }
done
[ -x "$mnt/打不开？双击我.command" ] || { log "helper .command is not executable"; helper_ok=0; }
hdiutil detach "$mnt" >/dev/null || hdiutil detach -force "$mnt" >/dev/null || true
rmdir "$mnt" 2>/dev/null || true
[ "$helper_ok" -eq 1 ] || die "DMG content check failed"
log "DMG ok: $dmg ($(du -h "$dmg" | cut -f1))"

assets=("$dmg")
[ -f "dist/${APP_NAME}-${version}.AppImage" ] && assets+=("dist/${APP_NAME}-${version}.AppImage")
[ -f "dist/${APP_NAME} Setup ${version}.exe" ] && assets+=("dist/${APP_NAME} Setup ${version}.exe")

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run artifacts:"; for a in "${assets[@]}"; do log "  $a"; done
  log "==== dry-run done (nothing tagged, pushed, released or installed)"
  RESULT="skipped dry-run (built ${version} ${short_sha} locally)"
  exit 0
fi

# ---------- 5. Move the nightly tag ----------
git tag -f -a "$NIGHTLY_TAG" -m "${APP_NAME} nightly ${version}" "$head_sha" >/dev/null || die "tag ${NIGHTLY_TAG} failed"
git push -f origin "refs/tags/${NIGHTLY_TAG}" || die "git push ${NIGHTLY_TAG} tag failed"
log "tag ${NIGHTLY_TAG} -> ${short_sha} pushed"

# ---------- 6. Refresh the single pre-release ----------
last_formal="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null || true)"
notes_file="$(mktemp /tmp/linkto-nightly-notes.XXXXXX)"
{
  echo "每日自动构建，版本 \`${version}\`（提交 \`${short_sha}\`）。未经完整测试，可能不稳定；正式版本见 Releases 中的 Latest。"
  echo
  echo "## 自 ${last_formal:-首个版本} 以来的变更"
  echo
  git log --no-merges --format='- %s' ${last_formal:+"${last_formal}..HEAD"} | grep -v '^- chore(release):' || echo "- 无代码变更"
  echo
  echo "## macOS 安装提示"
  echo
  echo "安装包未经 Apple 公证。若提示「已损坏，无法打开」，打开 DMG 后双击 \`打不开？双击我.command\`（详见 DMG 内 \`安装说明.txt\`），或在终端执行："
  echo
  echo '```'
  echo "xattr -dr com.apple.quarantine /Applications/${APP_NAME}.app && open /Applications/${APP_NAME}.app"
  echo '```'
  echo
  echo "<!-- nightly-sha: ${head_sha} -->"
} > "$notes_file"

title="Nightly · ${display_date}"
if gh release view "$NIGHTLY_TAG" -R "$GH_REPO" >/dev/null 2>&1; then
  gh release edit "$NIGHTLY_TAG" -R "$GH_REPO" --title "$title" --notes-file "$notes_file" \
    --prerelease --latest=false || die "gh release edit failed"
else
  gh release create "$NIGHTLY_TAG" -R "$GH_REPO" --verify-tag --title "$title" --notes-file "$notes_file" \
    --prerelease --latest=false || die "gh release create failed"
fi
rm -f "$notes_file"

gh release upload "$NIGHTLY_TAG" "${assets[@]}" -R "$GH_REPO" --clobber || die "asset upload failed"
# GitHub stores spaces in asset names as dots; drop assets from older nightlies.
keep="$(for a in "${assets[@]}"; do basename "$a" | tr ' ' '.'; done)"
gh release view "$NIGHTLY_TAG" -R "$GH_REPO" --json assets -q '.assets[].name' | while IFS= read -r name; do
  [ -n "$name" ] || continue
  if ! printf '%s\n' "$keep" | grep -qxF "$name"; then
    log "removing stale asset: $name"
    gh release delete-asset "$NIGHTLY_TAG" "$name" -R "$GH_REPO" -y || log "WARN: could not delete $name"
  fi
done
release_url="$(gh release view "$NIGHTLY_TAG" -R "$GH_REPO" --json url -q .url)"
log "release: $release_url"

# ---------- 7. Update the local app ----------
installed="(skipped)"
if [ "$NO_INSTALL" -eq 0 ]; then
  built_app="dist/mac-arm64/${APP_NAME}.app"
  [ -d "$built_app" ] || die "built app not found: $built_app"
  was_running=0
  if pgrep -xq "$APP_NAME"; then
    was_running=1
    log "quitting running ${APP_NAME}…"
    osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do pgrep -xq "$APP_NAME" || break; sleep 1; done
  fi
  if pgrep -xq "$APP_NAME"; then
    log "WARN: ${APP_NAME} did not quit within 30s; not replacing ${INSTALL_PATH} (nightly is published)"
    installed="(not replaced: app still running)"
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
    installed="$INSTALL_PATH"
    log "installed ${INSTALL_PATH}"
    if [ "$was_running" -eq 1 ]; then
      open "$INSTALL_PATH" || log "WARN: relaunch failed"
    fi
  fi
fi

# ---------- 8. Summary ----------
log "==== done: ${APP_NAME} nightly ${version}"
log "  release:   ${release_url}"
log "  dmg:       ${REPO_ROOT}/${dmg}"
log "  installed: ${installed}"
log "  log:       ${LOG_FILE}"
RESULT="built nightly ${version} ${short_sha}"
