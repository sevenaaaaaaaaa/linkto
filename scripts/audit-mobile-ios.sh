#!/bin/bash
# Visual checks use only newly created simulators and synthetic QA profiles.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="${1:-phone}"
case "$MODE" in
  phone) DEVICE=com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation ;;
  tablet) DEVICE=com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4-8GB ;;
  *) echo 'Usage: LINKTO_IOS_APP=<Release simulator .app> bash scripts/audit-mobile-ios.sh phone|tablet' >&2; exit 2 ;;
esac
test -d "${LINKTO_IOS_APP:?Set LINKTO_IOS_APP to the Release simulator app}"
PROJECT="$ROOT/.build/ios-visual-$MODE"
mkdir -p "$PROJECT"
xcodegen generate --spec mobile/e2e/project.yml --project "$PROJECT"
LINKTO_VISUAL_SIM="$(xcrun simctl create 'LinkTo isolated QA' "$DEVICE" ${LINKTO_IOS_SIM_RUNTIME:+"$LINKTO_IOS_SIM_RUNTIME"})"
cleanup() { xcrun simctl shutdown "$LINKTO_VISUAL_SIM" >/dev/null 2>&1 || true; xcrun simctl delete "$LINKTO_VISUAL_SIM" >/dev/null 2>&1 || true; }
trap cleanup EXIT
xcrun simctl boot "$LINKTO_VISUAL_SIM"
xcrun simctl bootstatus "$LINKTO_VISUAL_SIM" -b
if [ "$MODE" = phone ]; then
  xcrun simctl ui "$LINKTO_VISUAL_SIM" appearance dark
  xcrun simctl ui "$LINKTO_VISUAL_SIM" content_size accessibility-extra-extra-extra-large
fi
xcrun simctl install "$LINKTO_VISUAL_SIM" "$LINKTO_IOS_APP"
RESULT="$ROOT/.build/ios-ui-results/visual-$MODE-$(date +%Y%m%d-%H%M%S).xcresult"
STATUS=0
xcodebuild test -project "$PROJECT/LinkToQA.xcodeproj" -scheme LinkToQA -destination "platform=iOS Simulator,id=$LINKTO_VISUAL_SIM" -derivedDataPath "$ROOT/.build/ios-visual-$MODE-runner" -only-testing:LinkToQA/VisualAuditUITests -parallel-testing-enabled NO -collect-test-diagnostics never -resultBundlePath "$RESULT" CODE_SIGN_IDENTITY=- || STATUS=$?
xcrun xcresulttool export attachments --path "$RESULT" --output-path "${RESULT%.xcresult}-screenshots"
echo "Visual audit result: $RESULT"
exit "$STATUS"
