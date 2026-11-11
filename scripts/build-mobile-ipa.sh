#!/bin/bash
# Build a device Release IPA. Unsigned output is explicitly for re-signing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="${LINKTO_IOS_SIGNING:-automatic}"
if [ "${1:-}" = '--unsigned' ]; then MODE=unsigned; shift; fi
if [ "$#" -ne 0 ] || { [ "$MODE" != automatic ] && [ "$MODE" != unsigned ]; }; then
  echo 'Usage: LINKTO_IOS_TEAM=<team> bash scripts/build-mobile-ipa.sh | bash scripts/build-mobile-ipa.sh --unsigned' >&2
  exit 2
fi
if [ "$MODE" = automatic ] && [ -z "${LINKTO_IOS_TEAM:-}" ]; then
  echo 'Set LINKTO_IOS_TEAM to your Apple team ID; or pass --unsigned for a re-signing IPA.' >&2
  exit 2
fi
if [ "$MODE" = automatic ] && ! [[ "$LINKTO_IOS_TEAM" =~ ^[A-Z0-9]{10}$ ]]; then
  echo 'LINKTO_IOS_TEAM must be a 10-character Apple team ID.' >&2
  exit 2
fi
VERSION="$(node -p "require('./mobile/package.json').version")"
OUTPUT="$ROOT/.build/friends/ios"
ARCHIVE="$ROOT/.build/ios/LinkToMobile-$VERSION.xcarchive"
mkdir -p "$OUTPUT" "$(dirname "$ARCHIVE")"
BUILD_ARGS=(CODE_SIGNING_ALLOWED=NO)
if [ "$MODE" = automatic ]; then
  BUILD_ARGS=(-allowProvisioningUpdates "DEVELOPMENT_TEAM=$LINKTO_IOS_TEAM" CODE_SIGN_STYLE=Automatic CODE_SIGNING_ALLOWED=YES)
fi
xcodebuild -workspace mobile/ios/LinkToMobile.xcworkspace -scheme LinkToMobile \
  -configuration Release -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -derivedDataPath "${LINKTO_IOS_DERIVED_DATA:-$ROOT/.build/ios-derived}" "${BUILD_ARGS[@]}" archive
APP="$ARCHIVE/Products/Applications/LinkToMobile.app"
test -f "$APP/main.jsbundle"
test "$(/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$APP/Info.plist")" = iphoneos
xcrun lipo -verify_arch arm64 "$APP/LinkToMobile"
STAGING="$(mktemp -d "$OUTPUT/.ipa-XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
if [ "$MODE" = unsigned ]; then
  mkdir "$STAGING/Payload"
  ditto "$APP" "$STAGING/Payload/LinkToMobile.app"
  # Avoid inheriting stale signatures if a previously signed archive was reused.
  find "$STAGING/Payload" -type d -name _CodeSignature -prune -exec rm -rf {} +
  rm -f "$STAGING/Payload/LinkToMobile.app/embedded.mobileprovision"
  NAME="LinkTo-Mobile-$VERSION-unsigned.ipa"
  (cd "$STAGING" && /usr/bin/zip -qry "$NAME" Payload)
else
  cat > "$STAGING/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>debugging</string>
<key>teamID</key><string>$LINKTO_IOS_TEAM</string>
<key>signingStyle</key><string>automatic</string>
<key>stripSwiftSymbols</key><true/>
</dict></plist>
PLIST
  xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$STAGING/export" \
    -exportOptionsPlist "$STAGING/ExportOptions.plist" -allowProvisioningUpdates
  NAME="LinkTo-Mobile-$VERSION.ipa"
  EXPORTED="$STAGING/export/LinkToMobile.ipa"
  test -f "$EXPORTED"
  mkdir "$STAGING/verify"
  ditto -x -k "$EXPORTED" "$STAGING/verify"
  test -f "$STAGING/verify/Payload/LinkToMobile.app/embedded.mobileprovision"
  codesign --verify --deep --strict "$STAGING/verify/Payload/LinkToMobile.app"
  mv "$EXPORTED" "$STAGING/$NAME"
fi
unzip -tq "$STAGING/$NAME"
mv "$STAGING/$NAME" "$OUTPUT/$NAME"
(cd "$OUTPUT" && shasum -a 256 "$NAME" > "$NAME.sha256")
echo "IPA: $OUTPUT/$NAME (signing: $MODE)"
