# 林可兔移动版（LinkTo Mobile）

React Native 0.87，移动版独立版本 **0.5.0（build 5）**，共享 iOS / Android 业务代码。鸿蒙适配沿用 `harmony/README.md`，本轮未验证。

## 邮件、今日和随手记

- 主导航：邮件 / 今日 / 随手记 / 更多。全局「＋」选择写邮件或随手记；阅读邮件可直接「记下 / 转待办」，保留来源并返回原邮件。
- 随手记支持编辑、置顶、搜索。填入日期时间即成为待办；清除时间可回到随手记。
- 今日时间轴支持优先级、时长、完成 / 重新打开、固定时间，以及自动填入空档。时长按内容关键词建议 15 / 30 / 45 分钟，用户可修改；不是 AI 推断。
- 自动排程从当前时间向后安排至当日 20:00，保留固定时段，跳过未来日期任务；排不下的任务保留在待安排中。
- iOS 本机待办提醒：明确打开提醒开关后申请系统通知权限；完成 / 移除时取消提醒，排程或跨设备变更时更新。Android 本机任务提醒尚未实现。
- iOS 跟随系统深色模式；主要新增控件触控目标至少 44pt，支持读屏标签；捕获页和滑动组件尊重「减少动态效果」。

## 邮件能力与账户

统一收件箱、文件夹、服务端搜索、下拉刷新、前台每分钟收信、HTML / 纯文本阅读、回复和纯文本发信、已读 / 未读、AI 摘要与起草、萤火密信、保险箱保留。

服务商入口与桌面共享顺序：Proton、Gmail、微软、iCloud、自定义、网易、QQ、Yahoo、NAVER、AOL、腾讯企业邮箱、AgentMail / 自定义 Agent 邮箱。提供商按准确域名匹配，避免把相似域名误识别为已知服务商。

- 微软：Outlook / Hotmail / Live / Microsoft 365 合并为一个入口，使用设备代码浏览器授权与 XOAUTH2；按授权结果选择服务器。首次需要自己的 Microsoft 公共客户端 ID，注册应用需允许个人及组织账户、公共客户端流及 Exchange IMAP / SMTP 委派权限。组织管理员仍可限制 IMAP / SMTP，不会绕过租户策略。
- Gmail / iCloud / 网易 / QQ 等使用服务商要求的应用专用密码或授权码。Gmail 移动端本轮未接 Google OAuth。
- SMTP 支持 465 隐式 TLS 和 587 STARTTLS；未提供 STARTTLS 时取消登录。原生证书验证保持开启。
- Proton Bridge 仅在电脑运行，手机暂不能直接接入 Proton；手机同步应选择另一支持 IMAP 的邮箱。见 [Proton 官方说明](https://proton.me/support/imap-smtp-and-pop3-setup)。
- 收信命令统一使用 UID，并按账户串行访问连接；断线可重连，Microsoft 重连会刷新访问令牌。不能把服务器失败显示成空收件箱。

本机缓存使用 AES-GCM + 系统钥匙串随机密钥：最多 1200 条信封和最近 40 封正文。联网失败时显示已缓存内容；缓存不包含完整附件文件，也不代表整箱离线。

## 用自己的邮箱加密同步

1. 电脑和手机都添加同一个支持 IMAP 的同步邮箱。
2. 电脑「设置 → 同步与备份 → 手机与电脑」，手机「更多 → 加密同步」，选择同一邮箱与同一口令。
3. 保存并开启。手机解锁后、回到前台、前台每分钟、编辑后防抖自动同步；电脑沿用现有同步服务，并提供立即同步入口。

待办、随手记及其邮件来源放入 `LinkTo-Sync` 文件夹。它只是从本应用普通文件夹视图隐藏，在其他邮件客户端仍可能看见。新上传记录采用与桌面兼容的 scrypt + AES-256-GCM，标题和内容在加密正文中，口令保存在各设备系统凭据存储；服务商仍能看到记录数量和更新时间。

合并采用 `updatedAt` 后写者胜，移除使用墓碑传播。遇到错误口令，手机在上传前终止，保留本机数据。手机追加新版本，电脑同步时清理旧版本；仅用手机长期同步会积累历史记录。旧版电脑会忽略随手记，请同时更新电脑。旧版明文记录会补传加密版本；更新后的电脑会在同步轮次中替换并清理旧明文版本。仅用手机时，旧历史需等电脑同步后清理。

应用在后台被系统暂停时不会持续拉信或同步；没有 APNs / FCM 新邮件推送。已登记的 iOS 本机待办提醒可由系统触发。

## 开发与验证

```bash
cd mobile
npm ci
npm run typecheck
npm test -- --runInBand
# iOS
cd ios && pod install && cd ..
npm run ios
# Android：JDK 17 + Android SDK
npm run android
# 无需 Metro 的 Android 试用包（独立 .preview 应用 ID）
npm run android:preview
```

iPhone 用 Xcode 个人团队安装：用 Xcode 打开 `ios/LinkToMobile.xcworkspace`，连接并信任 iPhone，开启开发者模式，选择 LinkToMobile target 的 Signing & Capabilities → Automatically manage signing → Personal Team，然后把运行目标选为真实 iPhone。

初次开发可 Debug + Metro；日常独立使用在 Product → Scheme → Edit Scheme → Run 里选 Release，再运行，JS 会打进应用，不依赖 Metro。Bundle ID 如被占用需改为自己的唯一值。个人团队只用于自己的设备测试，须周期性重新部署，不提供朋友 TestFlight 分发。参见 [Apple 设备运行说明](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices) 与 [账户说明](https://developer.apple.com/help/account/basics/about-your-developer-account)。

## 当前边界

仍未补齐附件下载 / 预览、富文本与图片发信、邮件归档 / 删除 / 稍后处理、后台新邮件推送、离线发件队列、日历双向同步和完整 Sorted³ 拖拽交互。保险箱仍是本机数据，不包含在待办 / 随手记同步中。Android 深色模式及原生任务提醒待补齐。因此 0.5 是邮件工作台试用版，还不能承诺完整替代 Canary 与 Sorted³。

原有主密码、阶梯锁定 / 本地焚毁策略沿用；新增缓存、笔记密钥和同步口令纳入本地清理，iOS 已登记提醒也会清理。测试覆盖协议分包、UID、STARTTLS、加密存储并发、排程与实际组件新建路径；根目录 `npm run test:mail` 额外覆盖手机与电脑的加密互通及 SQLite 同步落库。
