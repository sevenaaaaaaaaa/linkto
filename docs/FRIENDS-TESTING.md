# LinkTo 朋友试用交付

本轮代码位于 `codex/mobile-workbench`。桌面版 0.7.5，移动版 0.5.0 / build 5；未推送或发布公开 Release。

## 已有与待执行的构建

| 平台 | 交付路径 | 当前验证 |
| --- | --- | --- |
| Android | `mobile/android/app/build/outputs/apk/preview/app-preview.apk` | 本机 `assemblePreview` 成功；未在真实 Android 设备验收 |
| iPhone / iPad | `mobile/ios/LinkToMobile.xcworkspace` | 模拟器 Release 编译、安装启动通过；真实手机需连接并用个人团队签名 |
| macOS Apple Silicon | `.build/friends/mac-arm64/LinkTo-0.7.5-arm64.dmg` | 本机打包；采用 ad-hoc 签名，未公证 |
| macOS Intel | `Friends preview builds` 工作流的 mac x64 artifact | 已配置，未在 Intel Mac 执行验收 |
| Windows x64 | `.build/friends/windows-x64/LinkTo Setup 0.7.5.exe` | 本机跨平台打包成功，未在 Windows 真机执行验收 |

桌面包已包含收信按钮、Screener 修复、随手记和手机同步配套代码。包文件保留在被 Git 忽略的构建目录，不提交大体积安装包。

## Android 试用

将 Preview APK 发给朋友安装。Preview 使用 `com.linktomobile.preview`，采用调试证书签名，与正式 `com.linktomobile` 的数据隔离。CI 调试证书可能随构建环境变化，不保证所有预览包之间可直接覆盖升级；稳定分发必须使用自己的持久签名密钥。

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

## 后续体验改进顺序

| 优先级 | 改进 | 目的 |
| --- | --- | --- |
| P0 | 邮件归档 / 删除 / 稍后处理、附件预览与后台推送 | 补齐日常邮件替代能力 |
| P1 | 排程可用时段设置、拖动改期、冲突提示、撤销 | 让今日时间轴更接近 Sorted³ 的日常操作 |
| P1 | 便签快速置顶、搜索结果突出匹配词、批量处理 | 降低记录与整理成本 |
| P1 | Android 深色模式、通知权限与提醒原生实现 | 缩小两种手机平台的体验差距 |
| P2 | 完成态轻触反馈、排程位置过渡、加载占位一致性 | 帮助理解状态变化；遵守减少动态效果设置 |
| P2 | 小组件、系统分享入口、桌面 / 手机快捷新建 | 减少捕获一封邮件或想法所需的步骤 |
