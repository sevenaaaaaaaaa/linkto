import XCTest

final class WorkbenchUITests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "com.linktomobile")
  override func setUp() { continueAfterFailure = false; app.launch() }
  override func tearDown() { capture("end-state") }
  func tap(_ label: String) {
    let button = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    if button.waitForExistence(timeout: 3) && button.isHittable { button.tap(); return }
    let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    XCTAssertTrue(element.waitForExistence(timeout: 5), "Missing: \(label)\n\(app.debugDescription)")
    element.tap()
  }
  func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func create(_ title: String, today: Bool) {
    tap("全局新建邮件或随手记"); tap("随手记 / 待办")
    let field = app.textFields["标题"]
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap()
    // Let each native key event settle; Simulator synthetic burst typing can drop keys.
    for character in title { field.typeText(String(character)) }
    XCTAssertEqual(field.value as? String, title, "Title must survive native keyboard input without losing characters")
    if today { tap("今天") }
    tap("保存")
    XCTAssertTrue(app.buttons["全局新建邮件或随手记"].waitForExistence(timeout: 5))
  }
  func testCapturePlanningAndNotes() {
    XCTAssertTrue(app.secureTextFields.firstMatch.waitForExistence(timeout: 10))
    XCTAssertEqual(app.secureTextFields.count, 2, "This test requires an isolated fresh simulator; never run against a real mailbox profile")
    app.secureTextFields.element(boundBy: 0).tap(); app.secureTextFields.element(boundBy: 0).typeText("LinkToQADemo9!")
    app.secureTextFields.element(boundBy: 1).tap(); app.secureTextFields.element(boundBy: 1).typeText("LinkToQADemo9!")
    tap("设置并进入")
    XCTAssertTrue(app.buttons["全局新建邮件或随手记"].waitForExistence(timeout: 15))
    create("Review customer mail", today: true)
    create("Draft project report", today: true)
    create("Notes for the next reply", today: false)
    tap("今日"); tap("自动排程")
    let handles = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "拖动任务调整顺序并重新排程")).allElementsBoundByIndex
    XCTAssertGreaterThanOrEqual(handles.count, 2)
    handles[0].press(forDuration: 0.2, thenDragTo: handles[1])
    tap("撤销")
    tap("完成 Review customer mail")
    tap("撤销")
    capture("today-light")
    tap("设置可用时段"); XCTAssertTrue(app.textFields["可用时段开始"].waitForExistence(timeout: 5)); capture("planning-light"); tap("取消")
    tap("随手记"); XCTAssertTrue(app.buttons["置顶便签"].waitForExistence(timeout: 5)); tap("置顶便签")
    XCTAssertTrue(app.buttons["取消置顶便签"].waitForExistence(timeout: 5)); capture("notes-light")
  }
}
