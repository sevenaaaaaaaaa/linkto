#!/bin/bash
# Shared by scripts/release.sh and scripts/daily-release.sh.
# Callers must set REPO_ROOT and define die().

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  else
    sha256sum "$1"
  fi
}

# write_sha256sums <out-file> <asset>...
# Standard sha256sum format with basenames, so users can run:
#   shasum -a 256 -c SHA256SUMS.txt
write_sha256sums() {
  local out="$1"
  shift
  : > "$out"
  local a base
  for a in "$@"; do
    base="$(basename "$a")"
    ( cd "$(dirname "$a")" && sha256_of "$base" ) >> "$out" || return 1
  done
}

# Browser reader page hash (same value as /api/v2/meta and the page footer).
reader_hash_line() {
  node --no-warnings --experimental-strip-types "$REPO_ROOT/scripts/fly-reader-hash.mts"
}

# append_checksum_notes <notes-file> <reader-line>
append_checksum_notes() {
  local notes="$1" reader="$2"
  {
    echo
    echo "## 校验和（SHA-256）"
    echo
    echo "- 安装包与校验清单：SHA256SUMS.txt（macOS/Linux：shasum -a 256 -c SHA256SUMS.txt；Windows：Get-FileHash -Algorithm SHA256 文件）"
    echo "- 浏览器阅读页：$reader"
    echo
    echo "阅读页哈希可用 npm run fly:reader-hash -- --file 保存的页面.html 复核（用 curl 保存原始页面；浏览器另存会重排 HTML）；与页面显示值不一致时不要输入 6 个词。"
  } >> "$notes"
}
