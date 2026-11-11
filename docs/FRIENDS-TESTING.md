# LinkTo 朋友试用交付

本轮代码位于 `codex/mobile-workbench`。桌面版 0.7.5，移动版 0.6.0 / build 6；未推送或发布公开 Release。

## 已有与待执行的构建

| 平台 | 交付路径 | 当前验证 |
| --- | --- | --- |
| Android | `.build/friends/android/LinkTo-Mobile-0.6.0-preview.apk`（原始产物在 `mobile/android/app/build/outputs/apk/preview/`） | 本机 `assemblePreview` 成功，签名验证通过；未在真实 Android 设备验收 |
| iPhone / iPad | `mobile/ios/LinkToMobile.xcworkspace` | 模拟器 Release 构建和原生界面流程通过；真机架构编译通过，实际安装需连接并用个人团队签名 |
| macOS Apple Silicon | `.build/friends/mac-arm64/LinkTo-0.7.5-arm64.dmg` | 本机打包；采用 ad-hoc 签名，未公证 |
| macOS Intel | `Friends preview builds` 工作流的 mac x64 artifact | 已配置，未在 Intel Mac 执行验收 |
| Windows x64 | `.build/friends/windows-x64/LinkTo Setup 0.7.5.exe` | 本机跨平台打包成功，未在 Windows 真机执行验收 |

桌面包已包含收信按钮、Screener 修复、随手记和手机同步配套代码。包文件保留在被 Git 忽略的构建目录，不提交大体积安装包。

## Android 试用

将 Preview APK 发给朋友安装。Preview 使用 `com.linktomobile.preview`，采用仓库固定的预览调试证书，与正式 `com.linktomobile` 的数据隔离，可覆盖升级之前使用同证书的 Preview。正式分发必须使用自己的持久签名密钥。

正式签名需要在环境中设置：`LINKTO_ANDROID_KEYSTORE`（绝对路径）、`LINKTO_ANDROID_STORE_PASSWORD`、`LINKTO_ANDROID_KEY_ALIAS`、`LINKTO_ANDROID_KEY_PASSWORD`，再执行 `mobile/android/gradlew -p mobile/android assembleRelease`。不要提交证书或密码。无配置的 Release 不会自动借用调试签名。

## 自己的 iPhone

1. Xcode 打开 `mobile/ios/LinkToMobile.xcworkspace`；Xcode Settings → Apple Accounts 登录自己的 Apple ID。
2. 插入 iPhone、信任这台 Mac，并按系统提示开启开发者模式。
3. LinkToMobile target → Signing & Capabilities → 自动签名，选择自己的 Personal Team；如 Bundle Identifier 已被占用，改为自己的唯一值。
4. 选择真实 iPhone 为运行目标。日常使用选 Run 的 Release 配置，然后运行；可以脱离 Metro 使用。
5. 免费个人团队需要周期性重新部署；不会生成可随意发给朋友安装的通用 IPA。工程没有写死开发团队或携带个人签名配置。

本轮检查时，本机有 Apple Development 证书，但没有连接真实 iPhone，因此尚未完成真机安装与通知点按验收。

## macOS 与 Windows 朋友包

`.github/workflows/friends-build.yml` 是手动触发的构建工作流，只上传 Actions artifacts，不创建 tag、GitHub Release 或自动发布：

- macOS arm64 DMG、macOS x64 DMG、Windows x64 NSIS 安装程序。
- Android Preview APK。
- iOS Simulator `.app`（明确不是 iPhone 安装包）。

工作流需要代码先进入 GitHub，再由维护者手动运行。仓库现有 nightly 发布脚本保持原流程。本轮未推送和运行远端工作流。

朋友公测包目前未配置 Windows 代码签名或 macOS Developer ID 公证，首次打开可能出现系统提示。面向更大范围分发前，应补齐稳定签名、升级兼容性和真机验收。

## 初次使用与同步

每位朋友设置自己的应用主密码、添加自己的邮箱，按服务商要求使用授权码 / OAuth；不要共享你的真实邮箱凭据。Microsoft 需要公共客户端 ID，Proton 电脑需要 Bridge，手机暂不支持直连 Proton。

同一用户的手机、电脑选择同一同步邮箱与口令，朋友之间分别配置。确认：手机新建随手记 → 电脑可编辑 → 手机看到更新；添加时间后转待办 → 完成 / 移除状态双向同步。暂时离线后本机缓存仍可读，联网后重新同步。

## 本轮完成情况和后续依赖

| 优先级 | 改进 | 目的 |
| --- | --- | --- |
| P0 | 已接入邮件归档 / 移至垃圾箱 / 稍后处理、15MB 内附件预览分享 | 真机外部服务商验收仍待完成 |
| P0 | 新邮件后台远程推送尚未启用 | 需要常开接收端、APNs / FCM 配置；当前 iPhone 使用 Personal Team |
| P1 | 已接入可用时段、休息与间隔、拖动顺序后重新排程、15 分钟改期、冲突提示、撤销 | 不是按比例时间网格；本机可用时段不跨设备同步 |
| P1 | 已接入便签直接置顶、搜索标题高亮、批量邮件处理、列表密度 | 批量移动部分失败会保留成功结果并报告 |
| P1 | 已接入 Android 深色模式、本机提醒、精确提醒设置与重启恢复 | 系统可延迟未获精确闹钟权限的提醒；待 Android 真机验收 |
| P2 | 已接入主要操作触感、180ms iOS 布局过渡、主题切换保留编辑器 | 遵守减少动态效果设置 |
| 后续 | 小组件、系统分享扩展、富文本发信、离线发件队列、日历双向同步 | 需要单独的功能实现与平台配置 |

原生界面测试脚本 `scripts/test-mobile-ios.sh` 会创建独立模拟器，测试中拒绝向已有主密码配置的环境输入密码；不会抹掉用户现有模拟器。首次启动系统迁移可能需要数分钟。结果与截图保存在 `.build/ios-ui-results/`。

本轮验证：移动端 15 个测试套件 / 56 项检查通过，桌面 16 组邮件与加密同步回归通过；原生 XCUITest 验证首次设置进入、完整标题保存、自动排程、拖动、完成与撤销、可用时段、便签置顶。已检查今日 / 时段 / 便签截图。真实服务商的归档 / 删除，以及 Android 系统提醒的实际交付时效仍需真机验收。

模拟器构建需要保留正常本地签名（脚本使用 `CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`），以生成钥匙串要求的模拟 entitlements；禁用全部签名只适用于编译检查，不能代表应用可正常访问钥匙串。首次设置主密码后会直接进入工作台，初始化异常独立显示重试入口。
