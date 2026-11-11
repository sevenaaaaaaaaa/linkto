#!/bin/bash
# Isolated native UI smoke test. Never reuses or erases a user's existing simulator.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v xcodegen >/dev/null || { echo 'Install XcodeGen to run native UI tests.' >&2; exit 1; }
mkdir -p .build/ios-ui-tests
xcodegen generate --spec mobile/e2e/project.yml --project .build/ios-ui-tests
LINKTO_QA_SIM="$(xcrun simctl create 'LinkTo isolated QA' com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro)"
cleanup() { xcrun simctl shutdown "$LINKTO_QA_SIM" >/dev/null 2>&1 || true; xcrun simctl delete "$LINKTO_QA_SIM" >/dev/null 2>&1 || true; }
trap cleanup EXIT
xcrun simctl boot "$LINKTO_QA_SIM"
xcrun simctl bootstatus "$LINKTO_QA_SIM" -b
if [ -z "${LINKTO_IOS_APP:-}" ]; then
  xcodebuild -workspace mobile/ios/LinkToMobile.xcworkspace -scheme LinkToMobile -configuration Release -sdk iphonesimulator -destination "platform=iOS Simulator,id=$LINKTO_QA_SIM" -derivedDataPath .build/mobile-ios CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
  LINKTO_IOS_APP="$ROOT/.build/mobile-ios/Build/Products/Release-iphonesimulator/LinkToMobile.app"
fi
xcrun simctl install "$LINKTO_QA_SIM" "$LINKTO_IOS_APP"
LINKTO_QA_RESULT="$ROOT/.build/ios-ui-results/$(date +%Y%m%d-%H%M%S).xcresult"
mkdir -p "$(dirname "$LINKTO_QA_RESULT")"
LINKTO_QA_EXIT=0
xcodebuild test -project .build/ios-ui-tests/LinkToQA.xcodeproj -scheme LinkToQA -destination "platform=iOS Simulator,id=$LINKTO_QA_SIM" -derivedDataPath .build/ios-ui-runner -parallel-testing-enabled NO -resultBundlePath "$LINKTO_QA_RESULT" CODE_SIGN_IDENTITY=- || LINKTO_QA_EXIT=$?
xcrun xcresulttool export attachments --path "$LINKTO_QA_RESULT" --output-path "${LINKTO_QA_RESULT%.xcresult}-screenshots"
echo "UI test results: $LINKTO_QA_RESULT"
exit "$LINKTO_QA_EXIT"
