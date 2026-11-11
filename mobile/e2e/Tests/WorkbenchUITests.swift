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
    app.secureTextFields.element(boundBy: 0).tap(); for character in "LinkToQADemo9!" { app.secureTextFields.element(boundBy: 0).typeText(String(character)) }
    app.secureTextFields.element(boundBy: 1).tap(); for character in "LinkToQADemo9!" { app.secureTextFields.element(boundBy: 1).typeText(String(character)) }
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
    tap("展开待办：Review customer mail")
    let inline = app.textFields["展开编辑标题"]
    XCTAssertTrue(inline.waitForExistence(timeout: 5)); inline.tap()
    inline.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Review customer mail".count))
    for character in "Review customer reply" { inline.typeText(String(character)) }
    XCTAssertEqual(inline.value as? String, "Review customer reply")
    inline.typeText("\n")
    tap("Agent"); tap("今日"); tap("展开待办：Review customer mail")
    XCTAssertEqual(app.textFields["展开编辑标题"].value as? String, "Review customer reply")
    XCTAssertTrue(app.staticTexts["已恢复未保存的输入"].exists)
    capture("inline-edit-light")
    tap("保存修改")
    XCTAssertTrue(app.buttons["展开待办：Review customer reply"].waitForExistence(timeout: 5))
    tap("批量选择"); tap("全选"); tap("删除"); tap("撤销")
    XCTAssertTrue(app.buttons["展开待办：Review customer reply"].waitForExistence(timeout: 5))
    app.buttons["展开待办：Review customer reply"].swipeLeft()
    capture("swipe-actions-light"); tap("删除"); tap("撤销")
    let target = app.buttons["展开待办：Review customer reply"]
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let start = origin.withOffset(CGVector(dx: app.frame.width * 0.90, dy: target.frame.midY))
    let end = origin.withOffset(CGVector(dx: app.frame.width * 0.12, dy: target.frame.midY))
    start.press(forDuration: 0.1, thenDragTo: end)
    let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: target)
    XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 5), .completed)
    tap("撤销"); XCTAssertTrue(target.waitForExistence(timeout: 5))
    capture("full-swipe-undo-light")
    capture("today-light")
    tap("设置可用时段"); XCTAssertTrue(app.textFields["可用时段开始"].waitForExistence(timeout: 5)); capture("planning-light"); tap("取消")
    tap("随手记"); XCTAssertTrue(app.buttons["置顶便签"].waitForExistence(timeout: 5)); tap("置顶便签")
    XCTAssertTrue(app.buttons["取消置顶便签"].waitForExistence(timeout: 5)); capture("notes-light")
    tap("Agent"); XCTAssertTrue(app.buttons["一键整理今日"].waitForExistence(timeout: 5))
    capture("agent-light"); tap("一键整理今日")
    XCTAssertTrue(app.staticTexts["今日安排已整理"].waitForExistence(timeout: 5)); capture("agent-receipt-light")
    tap("撤销本次操作")
    tap("今日"); tap("展开待办：Review customer reply"); tap("时间与提醒")
    tap("选择日期与时间"); XCTAssertTrue(app.buttons["确定时间"].waitForExistence(timeout: 5))
    tap("＋15 分"); capture("calendar-light"); tap("确定时间"); tap("保存")
    tap("批量选择"); tap("全选"); tap("移到文件夹")
    let folder = app.textFields["待办文件夹名称"]
    XCTAssertTrue(folder.waitForExistence(timeout: 5)); folder.tap(); for character in "Projects" { folder.typeText(String(character)) }; XCTAssertEqual(folder.value as? String, "Projects")
    tap("新建并移动"); tap("待办与随手记文件夹")
    XCTAssertTrue(app.buttons["选择待办文件夹 Projects"].waitForExistence(timeout: 5)); capture("collections-light"); tap("全部文件夹")
    // Verify scene foregrounding and a fresh process using the same local data.
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(app.buttons["全局新建邮件或随手记"].waitForExistence(timeout: 10))
    app.terminate()
    app.launch()
    XCTAssertTrue(app.secureTextFields.firstMatch.waitForExistence(timeout: 10))
    XCTAssertEqual(app.secureTextFields.count, 1, "Relaunch must unlock the existing profile, not recreate it")
    app.secureTextFields.firstMatch.tap(); for character in "LinkToQADemo9!" { app.secureTextFields.firstMatch.typeText(String(character)) }
    tap("解锁"); tap("今日")
    XCTAssertTrue(app.buttons["展开待办：Review customer reply"].waitForExistence(timeout: 10))
    capture("scene-relaunch-preserved-data")
    restoreFromDesktopBackup()
  }
  func testRestoreFromDesktopBackup() {
    XCTAssertTrue(app.secureTextFields.firstMatch.waitForExistence(timeout: 10))
    XCTAssertEqual(app.secureTextFields.count, 2, "Requires a fresh isolated QA simulator")
    for i in 0..<2 { app.secureTextFields.element(boundBy: i).tap(); for character in "LinkToQADemo9!" { app.secureTextFields.element(boundBy: i).typeText(String(character)) } }
    tap("设置并进入")
    XCTAssertTrue(app.buttons["全局新建邮件或随手记"].waitForExistence(timeout: 15))
    restoreFromDesktopBackup()
  }
  func restoreFromDesktopBackup() {
    tap("更多"); capture("more-desktop-brand")
    tap("从桌面备份恢复"); capture("restore-start")
    tap("选择 .lkbak 备份文件")
    // Browse the app's synthetic Documents fixture through the actual system picker.
    let browse = app.buttons.matching(NSPredicate(format: "label IN %@", ["Browse", "浏览"])).firstMatch
    if browse.waitForExistence(timeout: 5) { browse.tap() }
    let onPhone = app.staticTexts.matching(NSPredicate(format: "label IN %@", ["On My iPhone", "我的 iPhone", "我的iPhone"])).firstMatch
    if onPhone.waitForExistence(timeout: 5) { onPhone.tap() }
    let backupFolder = app.staticTexts["LinkTo"]
    if backupFolder.waitForExistence(timeout: 5) { backupFolder.tap() }
    let fixture = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "LinkTo-QA")).firstMatch
    XCTAssertTrue(fixture.waitForExistence(timeout: 10), "Fixture missing in system picker: \(app.debugDescription)")
    fixture.tap()
    let password = app.secureTextFields["备份口令"]
    XCTAssertTrue(password.waitForExistence(timeout: 10)); password.tap(); for character in "wrong" { password.typeText(String(character)) }
    tap("解密并预览")
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "备份口令不正确")).firstMatch.waitForExistence(timeout: 30))
    password.tap(); password.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5)); for character in "LinkToBackupQA9!" { password.typeText(String(character)) }
    tap("解密并预览")
    XCTAssertTrue(app.staticTexts["选择要带回的内容"].waitForExistence(timeout: 30)); capture("restore-preview")
    tap("合并恢复所选内容")
    XCTAssertTrue(app.staticTexts["恢复完成"].waitForExistence(timeout: 15)); capture("restore-complete")
    tap("查看邮箱与登录状态")
    XCTAssertTrue(app.staticTexts["qa@example.invalid"].waitForExistence(timeout: 5))
    tap("今日"); tap("随手记")
    XCTAssertTrue(app.buttons["展开随手记：Restored desktop note"].waitForExistence(timeout: 10)); capture("restore-note-preserved")
  }
}
