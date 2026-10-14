#!/bin/bash
# Daily release for LinkTo: sync -> typecheck -> bump patch -> build (mac dmg + win + linux)
# -> commit/tag -> push -> GitHub Release -> update /Applications/LinkTo.app.
#
# Usage: scripts/daily-release.sh [--dry-run] [--no-install] [--force]
#   --dry-run     build + package locally only (no bump/commit/tag/push/release/install)
#   --no-install  do not replace /Applications/LinkTo.app
#   --force       release even if there are no new commits since the latest v* tag
#
# Safe for unattended launchd runs: no prompts; exits 0 when skipped, non-zero only on real failure.

set -euo pipefail

APP_NAME="LinkTo"
GH_REPO="sevenaaaaaaaaa/linkto"
BRANCH="main"
LOG_FILE="${HOME}/Library/Logs/linkto-daily-release.log"
INSTALL_PATH="/Applications/${APP_NAME}.app"

DRY_RUN=0
NO_INSTALL=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
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
die() { log "ERROR: $*"; exit 1; }
skip() { log "SKIPPED: $*"; exit 0; }

log "==== ${APP_NAME} daily release start (dry-run=${DRY_RUN} no-install=${NO_INSTALL} force=${FORCE}) in ${REPO_ROOT}"

for tool in git node npm; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done
if [ "$DRY_RUN" -eq 0 ]; then
  command -v gh >/dev/null || die "missing tool: gh"
  gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
fi

# ---------- 1. Preconditions ----------
current_branch="$(git rev-parse --abbrev-ref HEAD)"
dirty="$(git status --porcelain)"

if [ "$DRY_RUN" -eq 1 ]; then
  [ "$current_branch" = "$BRANCH" ] || log "WARN: on branch '${current_branch}', not '${BRANCH}' (dry-run continues)"
  [ -z "$dirty" ] || { log "WARN: working tree is dirty (dry-run continues):"; printf '%s\n' "$dirty"; }
else
  [ "$current_branch" = "$BRANCH" ] || skip "not on '${BRANCH}' (on '${current_branch}')"
  if [ -n "$dirty" ]; then
    log "working tree has uncommitted changes, not releasing (never auto-committing WIP):"
    printf '%s\n' "$dirty"
    skip "dirty working tree"
  fi
fi

log "fetching origin…"
if ! git fetch --tags origin; then
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
  fi
fi

log "running checks: npm run typecheck"
[ -d node_modules ] || npm ci --no-audit --no-fund || die "npm ci failed"
npm run typecheck || die "typecheck failed"

# ---------- 2. Anything to release? ----------
last_tag="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
resume_tag=""
if [ -n "$last_tag" ]; then
  new_commits="$(git rev-list --count "${last_tag}..HEAD")"
else
  new_commits="$(git rev-list --count HEAD)"
fi
log "latest tag: ${last_tag:-<none>}, commits since: ${new_commits}"

if [ "$DRY_RUN" -eq 0 ] && [ "$new_commits" -eq 0 ] && [ -n "$last_tag" ]; then
  # Resume a previous run that tagged but did not finish publishing.
  if ! gh release view "$last_tag" -R "$GH_REPO" >/dev/null 2>&1; then
    log "tag ${last_tag} is on HEAD but has no GitHub Release yet -> resuming publish"
    resume_tag="$last_tag"
  elif [ "$FORCE" -eq 0 ]; then
    skip "no new commits since ${last_tag}"
  fi
fi

# ---------- 3. Version ----------
current_version="$(node -p "require('./package.json').version")"
if [ "$DRY_RUN" -eq 1 ]; then
  version="$current_version"
  log "dry-run: building current version ${version} (no bump)"
elif [ -n "$resume_tag" ]; then
  version="${resume_tag#v}"
  [ "$version" = "$current_version" ] || die "tag ${resume_tag} does not match package.json ${current_version}"
else
  # Version lives in package.json (+ root entries of package-lock.json). mobile/ is versioned separately.
  npm version patch --no-git-tag-version >/dev/null || die "version bump failed"
  version="$(node -p "require('./package.json').version")"
  git rev-parse -q --verify "refs/tags/v${version}" >/dev/null && {
    git checkout -- package.json package-lock.json
    die "tag v${version} already exists locally"
  }
  log "bumped version ${current_version} -> ${version}"
fi
tag="v${version}"

# ---------- 4. Build ----------
dmg="dist/${APP_NAME}-${version}-arm64.dmg"
build_start=$(date +%s)
log "building: npm run dist (mac dmg + win nsis + linux AppImage)…"
if ! npm run dist; then
  if [ "$DRY_RUN" -eq 0 ] && [ -z "$resume_tag" ]; then
    git checkout -- package.json package-lock.json
  fi
  die "build failed"
fi
log "build finished in $(( $(date +%s) - build_start ))s"
[ -f "$dmg" ] || die "expected DMG not found: $dmg"

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
  log "==== dry-run done (nothing committed, pushed, released or installed)"
  exit 0
fi

# ---------- 3b. Commit + tag (after a successful build) ----------
if [ -z "$resume_tag" ]; then
  git add package.json package-lock.json
  git commit -m "chore(release): ${tag}" || die "release commit failed"
  git tag -a "$tag" -m "${APP_NAME} ${tag}" || die "tag failed"
  log "committed and tagged ${tag}"
fi

# ---------- 5. Push + GitHub Release ----------
git push origin "$BRANCH" || die "git push failed"
git push origin "$tag" || die "git push tag failed"

prev_tag="$(git describe --tags --abbrev=0 --match 'v*' "${tag}^" 2>/dev/null || true)"
notes_file="$(mktemp /tmp/linkto-release-notes.XXXXXX)"
{
  echo "## 变更"
  echo
  git log --no-merges --format='- %s' ${prev_tag:+"${prev_tag}..${tag}"} | grep -v '^- chore(release):' || echo "- 例行发版"
  echo
  echo "## macOS 安装提示"
  echo
  echo "安装包未经 Apple 公证。若提示「已损坏，无法打开」，打开 DMG 后双击 \`打不开？双击我.command\`（详见 DMG 内 \`安装说明.txt\`），或在终端执行："
  echo
  echo '```'
  echo "xattr -dr com.apple.quarantine /Applications/${APP_NAME}.app && open /Applications/${APP_NAME}.app"
  echo '```'
} > "$notes_file"

if gh release view "$tag" -R "$GH_REPO" >/dev/null 2>&1; then
  # Release already exists (e.g. created elsewhere): only add assets that are missing, never clobber.
  existing="$(gh release view "$tag" -R "$GH_REPO" --json assets -q '.assets[].name')"
  for a in "${assets[@]}"; do
    name="$(basename "$a" | tr ' ' '.')"
    if printf '%s\n' "$existing" | grep -qxF "$name"; then
      log "asset already on release, keeping: $name"
    else
      gh release upload "$tag" "$a" -R "$GH_REPO" || die "upload failed: $a"
    fi
  done
else
  gh release create "$tag" "${assets[@]}" -R "$GH_REPO" --title "${APP_NAME} ${tag}" --notes-file "$notes_file" \
    || die "gh release create failed"
fi
rm -f "$notes_file"
release_url="$(gh release view "$tag" -R "$GH_REPO" --json url -q .url)"
log "release: $release_url"

# ---------- 6. Update the local app ----------
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
    log "WARN: ${APP_NAME} did not quit within 30s; not replacing ${INSTALL_PATH} (release is published)"
    installed="(not replaced: app still running)"
  else
    staging="${INSTALL_PATH%.app}.new.app"
    rm -rf "$staging"
    ditto "$built_app" "$staging" || die "ditto failed"
    xattr -dr com.apple.quarantine "$staging" 2>/dev/null || true
    if [ -d "$INSTALL_PATH" ]; then
      old="$(mktemp -d /tmp/linkto-old-app.XXXXXX)"
      mv "$INSTALL_PATH" "$old/" || die "cannot move old app aside"
    fi
    mv "$staging" "$INSTALL_PATH" || die "cannot move new app into place"
    [ -n "${old:-}" ] && rm -rf "$old"
    installed="$INSTALL_PATH"
    log "installed ${INSTALL_PATH}"
    if [ "$was_running" -eq 1 ]; then
      open "$INSTALL_PATH" || log "WARN: relaunch failed"
    fi
  fi
fi

# ---------- 7. Summary ----------
log "==== done: ${APP_NAME} ${tag}"
log "  release:   ${release_url}"
log "  dmg:       ${REPO_ROOT}/${dmg}"
log "  installed: ${installed}"
log "  log:       ${LOG_FILE}"
