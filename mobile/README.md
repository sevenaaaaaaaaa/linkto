# 林可兔移动版（LinkTo Mobile）

React Native 0.87，移动版独立版本 **0.6.0（build 6）**，共享 iOS / Android 业务代码。鸿蒙适配沿用 `harmony/README.md`，本轮未验证。

## 邮件、今日和随手记

- 主导航：邮件 / 今日 / 随手记 / 更多。全局「＋」选择写邮件或随手记；阅读邮件可直接「记下 / 转待办」，保留来源并返回原邮件。
- 随手记支持编辑、置顶、搜索。填入日期时间即成为待办；清除时间可回到随手记。
- 今日时间轴支持优先级、时长、完成 / 重新打开、固定时间，以及自动填入空档。时长按内容关键词建议 15 / 30 / 45 分钟，用户可修改；不是 AI 推断。
- 自动排程支持自定义开始 / 结束、休息时段、任务间隔；默认 09:00–20:00、12:00–13:00 休息。保留固定时段、跳过未来日期任务；排不下的任务保留待安排。可用时段是本机设置。
- 今日拖动「≡」可调整任务顺序并重新排程，支持读屏上移 / 下移；固定日程不可拖动。操作菜单可按 15 分钟微调，显示与其他任务的时间冲突。
- 完成、移除、置顶、排程和拖动后提供撤销；若相关记录已被其他设备更新，撤销会拒绝覆盖新版本。
- iOS / Android 本机待办提醒：打开提醒开关后申请系统通知权限，完成 / 移除时取消，排程或跨设备变更时更新。Android 支持重启恢复；未允许精确闹钟时用系统弹性提醒，可能延迟，可在「更多 → 提醒与收信」打开系统设置。
- 两端跟随系统深色模式；Android 更换主题不重建编辑器。主要新增控件触控目标至少 44pt，支持读屏标签；捕获页、滑动与布局过渡尊重「减少动态效果」。
- 便签提供直接置顶入口，任务 / 便签搜索突出匹配标题。

## 邮件能力与账户

统一收件箱、文件夹、服务端搜索、下拉刷新、前台每分钟收信、HTML / 纯文本阅读、回复和纯文本发信、已读 / 未读、AI 摘要与起草、萤火密信、保险箱保留。

- 邮件操作菜单：归档、移至垃圾箱、稍后处理、已读 / 未读；支持批量归档、标已读、移至垃圾箱。支持紧凑 / 舒适列表和搜索高亮。
- 移动优先用 UID MOVE，旧服务器回退 UID COPY + 标记原邮件删除 + UID EXPUNGE；绝不执行会清理无关邮件的全箱 EXPUNGE。服务器提供新 UID 或可按 Message-ID 找回时，提供 10 秒撤销入口。中途失败会明确保留部分成功的结果。
- 稍后处理提供一小时后、明早、下周一，作为固定时间的邮件待办加密同步；本应用手机收件箱暂时隐藏该邮件，列表有计数和单独入口，到时恢复显示。电脑能收到对应待办，电脑收件箱的原有稍后处理状态暂不与此手机过滤双向绑定。
- 附件支持 15MB 内的系统预览 / 分享保存：iOS Quick Look、Android 文件查看器 / 分享面板。临时文件在应用私有目录，iOS 受文件保护、Android 通过只读 FileProvider 分享，超过一天的临时文件在下次打开附件时清理；本地焚毁也会清理。正文缓存只保存附件元数据，离线附件需联网重新加载。

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
# 原生 iOS UI 冒烟（需要 XcodeGen；自动创建并清理独立模拟器）
cd .. && bash scripts/test-mobile-ios.sh
```

iPhone 用 Xcode 个人团队安装：用 Xcode 打开 `ios/LinkToMobile.xcworkspace`，连接并信任 iPhone，开启开发者模式，选择 LinkToMobile target 的 Signing & Capabilities → Automatically manage signing → Personal Team，然后把运行目标选为真实 iPhone。

初次开发可 Debug + Metro；日常独立使用在 Product → Scheme → Edit Scheme → Run 里选 Release，再运行，JS 会打进应用，不依赖 Metro。Bundle ID 如被占用需改为自己的唯一值。个人团队只用于自己的设备测试，须周期性重新部署，不提供朋友 TestFlight 分发。参见 [Apple 设备运行说明](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices) 与 [账户说明](https://developer.apple.com/help/account/basics/about-your-developer-account)。

## 当前边界

仍未补齐富文本与图片发信、后台新邮件推送、离线发件队列、日历双向同步、小组件与系统分享扩展。拖动目前用于今日重新排程，尚不是按比例的日历时间网格。保险箱仍是本机数据，不包含在待办 / 随手记同步中。因此 0.6 是邮件工作台试用版，还不能承诺完整替代 Canary 与 Sorted³。

新邮件远程推送需要 APNs / FCM 配置和常开接收端；当前自己的 iPhone 采用 Personal Team 安装，尚不具备可用 APNs 分发配置。这里没有用前台轮询冒充后台推送，也没有把邮箱凭据交给新的服务端。参见 [Apple 能力表](https://developer.apple.com/help/account/reference/supported-capabilities-ios)。

原有主密码、阶梯锁定 / 本地焚毁策略沿用；新增缓存、笔记密钥和同步口令纳入本地清理，iOS 已登记提醒也会清理。测试覆盖协议分包、UID、STARTTLS、加密存储并发、排程与实际组件新建路径；根目录 `npm run test:mail` 额外覆盖手机与电脑的加密互通及 SQLite 同步落库。
