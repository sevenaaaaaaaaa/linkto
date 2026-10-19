#!/bin/bash
# One-time setup: create a local self-signed code-signing identity "LinkTo Local Signing" in your login keychain,
# so nightly / release builds (scripts/daily-release.sh, scripts/release.sh) are signed with a STABLE identity.
#
# Why: builds are otherwise ad-hoc signed ("-"), so every build has a different code signature. macOS ties
# keychain approvals ("Always Allow" for "linkto Safe Storage", which protects mail passwords / AI keys) to the
# app's designated requirement, so after every nightly update macOS asks again. With a stable identity the
# designated requirement stays the same and one "Always Allow" is enough.
#
# What it does (only on this Mac, nothing leaves the machine):
#   1. generates a 10-year self-signed certificate + private key (codeSigning EKU) with /usr/bin/openssl
#   2. imports it into the login keychain, allowing /usr/bin/codesign to use the key
#   3. trusts the certificate for code signing (macOS asks for your login password to change trust settings)
#   4. optionally lets codesign use the key without a prompt (needs the login keychain password once;
#      recommended, otherwise the unattended 23:00 nightly build would stop at a keychain dialog)
#   5. signs a throw-away copy of /usr/bin/true to verify the identity works
#
# Usage:
#   scripts/setup-signing.sh            # set up (idempotent: does nothing if the identity is already valid)
#   scripts/setup-signing.sh --check    # only report the current state
#   scripts/setup-signing.sh --remove   # delete the identity and its trust setting again
#
# Note: the private key never leaves the login keychain; the temporary files are deleted at the end.
# After setting up, the next installed build triggers ONE last keychain prompt — choose "始终允许 / Always Allow".

set -euo pipefail

NAME="${LINKTO_SIGN_IDENTITY:-LinkTo Local Signing}"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
OPENSSL=/usr/bin/openssl   # LibreSSL: its PKCS#12 output is importable by `security`

say() { printf '%s\n' "$*"; }
die() { say "错误：$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "只适用于 macOS"
[ -x "$OPENSSL" ] || die "找不到 $OPENSSL"

valid_identity() { security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -qF "\"${NAME}\""; }
cert_present() { security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; }

case "${1:-}" in
  --check)
    if valid_identity; then say "✓ 已就绪：代码签名身份「${NAME}」可用，打包脚本会自动使用它。"
    elif cert_present; then say "△ 证书「${NAME}」已在钥匙串里，但还没被信任为代码签名证书：重新运行 scripts/setup-signing.sh 完成设置。"
    else say "✗ 未设置：打包会用 ad-hoc 签名（每次更新后 macOS 都会重新询问钥匙串授权）。运行 scripts/setup-signing.sh 设置。"
    fi
    exit 0
    ;;
  --remove)
    if cert_present; then
      tmp="$(mktemp -d)"
      security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$tmp/cert.pem" || true
      security remove-trusted-cert "$tmp/cert.pem" 2>/dev/null || true
      rm -f "$tmp/cert.pem"; rmdir "$tmp"
      security delete-identity -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1 || security delete-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1 || true
      say "已删除「${NAME}」。之后的构建回到 ad-hoc 签名。"
    else
      say "钥匙串里没有「${NAME}」，无需删除。"
    fi
    exit 0
    ;;
  "") ;;
  -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
  *) die "未知参数：$1（可用：--check / --remove）" ;;
esac

if valid_identity; then
  say "✓ 代码签名身份「${NAME}」已存在且可用，无需重复设置。"
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/linkto-signing.XXXXXX")"
chmod 700 "$work"
cleanup() {
  rm -f "$work/key.pem" "$work/cert.pem" "$work/id.p12" "$work/ext.cnf" "$work/true-test"
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT

if cert_present; then
  say "证书「${NAME}」已在钥匙串里，只补做信任设置。"
  security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$work/cert.pem"
else
  say "1/5 生成自签名代码签名证书「${NAME}」（10 年有效，只在本机使用）…"
  cat > "$work/ext.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = ${NAME}
[ ext ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
  "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$work/key.pem" -out "$work/cert.pem" -config "$work/ext.cnf" >/dev/null 2>&1 \
    || die "openssl 生成证书失败"
  pass="$("$OPENSSL" rand -hex 16)"
  "$OPENSSL" pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$NAME" \
    -out "$work/id.p12" -passout "pass:${pass}" >/dev/null 2>&1 || die "openssl 导出 PKCS#12 失败"

  say "2/5 导入登录钥匙串（允许 codesign 使用该私钥）…"
  security import "$work/id.p12" -k "$KEYCHAIN" -P "$pass" -T /usr/bin/codesign -T /usr/bin/security >/dev/null \
    || die "security import 失败"
  rm -f "$work/key.pem" "$work/id.p12"
  unset pass
fi

say "3/5 把证书设为「代码签名」信任（macOS 会请你输入本机登录密码确认）…"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$work/cert.pem" \
  || die "信任设置失败（可在「钥匙串访问」里找到「${NAME}」→ 显示简介 → 信任 → 代码签名：始终信任）"

say "4/5 让 codesign 无需弹窗即可使用该私钥（夜间自动构建不能停在对话框上）。"
say "    需要输入一次「登录钥匙串」密码（通常就是本机登录密码；不会被保存）。直接回车可跳过——"
say "    跳过的话，第一次签名时会弹出「codesign 想要访问钥匙串」，点「始终允许」即可。"
read -r -s -p "    登录钥匙串密码：" kcpass || kcpass=""
say ""
if [ -n "$kcpass" ]; then
  if security set-key-partition-list -S apple-tool:,apple:,codesign: -s -l "$NAME" -k "$kcpass" "$KEYCHAIN" >/dev/null 2>&1; then
    say "    已设置。"
  else
    say "    设置失败（密码不对？）。可稍后重跑本脚本，或在第一次签名弹窗时点「始终允许」。"
  fi
fi
unset kcpass

say "5/5 验证：用「${NAME}」签一个临时文件…"
cp /usr/bin/true "$work/true-test"
if codesign --force --timestamp=none -s "$NAME" "$work/true-test" >/dev/null 2>&1 && codesign --verify "$work/true-test" >/dev/null 2>&1; then
  say "    签名成功；designated requirement：$(codesign -d -r- "$work/true-test" 2>&1 | sed -n 's/^designated => //p')"
else
  die "验证签名失败：运行 'security find-identity -v -p codesigning' 检查「${NAME}」是否出现在有效身份里"
fi

valid_identity || die "身份已导入，但未出现在有效的代码签名身份里（信任设置未生效？）"
say ""
say "✓ 完成。之后 scripts/daily-release.sh / scripts/release.sh 会自动用「${NAME}」签名。"
say "  下一次安装新版本后，macOS 会最后询问一次钥匙串授权（「linkto Safe Storage」）——请点「始终允许」，以后更新不再询问。"
