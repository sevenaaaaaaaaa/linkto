#!/bin/bash
# Shared by scripts/daily-release.sh and scripts/release.sh (source it; needs a `log` function).
#
# Picks the macOS code-signing identity for electron-builder:
#   - "$LINKTO_SIGN_IDENTITY" if set, else "LinkTo Local Signing" (created once by scripts/setup-signing.sh),
#     when it is a valid code-signing identity in the keychain search list -> stable designated requirement,
#     so the macOS keychain "Always Allow" for "linkto Safe Storage" survives every nightly update;
#   - otherwise ad-hoc ("-", electron-builder.yml default): every build gets a new cdhash and macOS asks for
#     keychain access again after each install.
# Result: the array MAC_SIGN_ARGS (extra electron-builder CLI flags, possibly empty) and MAC_SIGN_DESC.
# The DMG's "打不开？双击我.command" helper is unaffected: a self-signed signature still verifies
# (codesign --verify does not need a trusted root), and on failure it still falls back to ad-hoc re-signing.

MAC_SIGN_ARGS=()
MAC_SIGN_DESC="ad-hoc"
_linkto_sign_identity="${LINKTO_SIGN_IDENTITY:-LinkTo Local Signing}"
if [ "$(uname -s)" = "Darwin" ] && command -v security >/dev/null 2>&1 \
  && security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"${_linkto_sign_identity}\""; then
  # timestamp=none: a self-signed identity cannot use Apple's timestamp service (and nightly builds must not need the network for signing)
  MAC_SIGN_ARGS=("-c.mac.identity=${_linkto_sign_identity}" "-c.mac.timestamp=none")
  MAC_SIGN_DESC="identity \"${_linkto_sign_identity}\""
  log "signing: ${MAC_SIGN_DESC} (stable signature; keychain approvals carry over between builds)"
else
  log "signing: identity \"${_linkto_sign_identity}\" not found -> ad-hoc. macOS will ask for keychain access (\"linkto Safe Storage\") again after each install; run scripts/setup-signing.sh once to fix."
fi
unset _linkto_sign_identity
