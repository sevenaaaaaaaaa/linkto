import XCTest

final class VisualAuditUITests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "com.linktomobile")
  override func setUp() { continueAfterFailure = false; app.launch() }
  func capture(_ name: String) { let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment) }
  func tap(_ label: String) {
    let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    XCTAssertTrue(element.waitForExistence(timeout: 10), "Missing \(label)")
    for _ in 0..<5 { if element.isHittable { break }; app.swipeUp() }
    element.tap()
  }
  func testBrandAndAccessibilityScreens() {
    XCTAssertTrue(app.secureTextFields.firstMatch.waitForExistence(timeout: 10))
    capture("visual-guard")
    let fields = app.secureTextFields.count
    XCTAssertTrue(fields == 1 || fields == 2, "Only run via the isolated QA script")
    for i in 0..<fields { let field = app.secureTextFields.element(boundBy: i); for _ in 0..<6 { if field.isHittable { break }; app.swipeUp() }; field.tap(); for character in "LinkToQADemo9!" { field.typeText(String(character)) } }
    tap(fields == 2 ? "设置并进入" : "解锁")
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "全局新建")).firstMatch.waitForExistence(timeout: 15))
    capture("visual-onboarding")
    tap("今日"); capture("visual-today")
    let guide = app.staticTexts.matching(identifier: "今天，先从一件事开始").firstMatch
    if guide.exists && app.frame.width < 600 {
      let before = guide.frame.minY
      app.swipeUp()
      XCTAssertLessThan(guide.frame.minY, before, "Timeline must scroll at large text sizes")
      capture("visual-today-scrollable")
    }
    tap("Agent"); capture("visual-agent")
    tap("更多"); capture("visual-more")
    tap("从桌面备份恢复"); capture("visual-restore")
    tap("关闭恢复备份")
    if app.frame.width > 600 {
      XCUIDevice.shared.orientation = .landscapeLeft
      let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.app.frame.width > self.app.frame.height }, object: nil)
      XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 8), .completed)
      tap("从桌面备份恢复"); capture("visual-tablet-landscape-restore")
      tap("关闭恢复备份")
      capture("visual-tablet-landscape")
      XCUIDevice.shared.orientation = .portrait
    }
  }
}
