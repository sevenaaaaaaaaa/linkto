# 林可兔移动版（LinkTo Mobile）

React Native 0.87 · 一套代码三平台：**Android / iOS / 鸿蒙（RNOH）**

> 版本：移动版独立编号，与桌面版（仓库根 `package.json`）不同步，也不随桌面版的 Nightly / 正式 Release 发包。当前 0.4.0，
> 以下三处须保持一致：`mobile/package.json`、Android `android/app/build.gradle` 的 `versionName`（`versionCode` 递增）、
> iOS 工程的 `MARKETING_VERSION`。

```
mobile/
├── src/
│   ├── imap/ImapLite.ts     # 原生 TLS socket 上的极简 IMAP 客户端
│   ├── store/mail.ts        # zustand 状态层（账户/收件箱/阅读）
│   ├── screens/             # 账户 / 收件箱 / 阅读三屏
│   └── theme.ts             # 对齐桌面端「石墨纸 + 铜绿」token
├── ios/                     # Xcode 工程（CocoaPods）
├── android/                 # Gradle 工程
└── harmony/                 # 鸿蒙（RNOH）接入，见 harmony/README.md
```

## v0.1 功能

- IMAP 账户添加（凭据入系统钥匙串：iOS Keychain / Android Keystore / 鸿蒙 Asset 待接）
- 收件箱列表（最近 50 封 envelope）+ 正文阅读（text/plain）+ 已读回写
- 常用服务商服务器自动猜测（Gmail/QQ/163/Outlook/iCloud）

## 安全（v0.2 守卫层）

- **主密码**：首次启动设置，每次启动需解锁；验证器存系统钥匙串（未 root 不可导出）
- **阶梯焚毁**（密码）：错 5 次锁 15 分钟（每 5 次翻倍：15m→30m→60m…），累计 15 次 → 焚毁钥匙串主密钥/全部账户凭据/本地账户索引，并清保险箱密钥、保险箱密文与 AI Key，物理不可恢复
- **中间人即焚**：IMAP TLS 证书校验开启（自签/劫持/抓包工具）→ 判定确证中间人 → 立即焚毁本地数据
- 单测覆盖：`npx jest`（阶梯锁定/翻倍/焚毁/中间人判定/SHA-256 向量）
- 诚实边界：焚毁只作用于本地；服务器上的邮件与离线拷贝的密文不在焚毁范围

## 平板适配（iPad / Android 平板 / 鸿蒙 MatePad）

- 断点：`src/hooks/useTablet.ts`，短边 ≥ 600 判定为平板（手机横屏不误判）
- 收件箱双栏：左列表（380pt，选中铜绿淡底高亮）+ 右阅读（ReadScreen embedded 嵌入，✕ 关闭）
- 账户页：内容限宽 640 居中
- 手机保持单栏压栈导航不变

## 开发

```bash
npm install
# iOS（需 Xcode + CocoaPods）
cd ios && pod install && cd .. && npm run ios
# Android（需 JDK 17 + Android SDK；JAVA_HOME 指向 JDK17）
npm run android
```

## v0.4.0 追加（本轮三轮回补）

**第一轮：邮件客户端本体**

- 底部四入口：邮件 / 加密 / 保险箱 / 设置；iPad 左侧 Rail + 列表 + 阅读三栏
- 统一收件箱：多 IMAP 账户合并，账户色标；账户 / 文件夹切换（LSUB）
- IMAP SEARCH 搜索发件人 / 主题 / 正文；下拉刷新、骨架屏、空状态
- HTML 阅读：完整 MIME 解析（multipart/alternative、base64、quoted-printable），WebView 禁 JS；默认 CSP 拦截远程图片，可手动放行
- SMTP 发信：465 隐式 TLS，AUTH LOGIN 失败降级 PLAIN；写信 / 回复（In-Reply-To / References），纯文本 UTF-8 base64
- 附件元数据（文件名 / 类型 / 大小）；目前只展示，不下载
- 已读回写、标为未读、横滑切换上一封/下一封

**第二轮：萤火密信 + 保险箱**

- 萤火密信 v2 与桌面端字节级兼容：链接 / 链接+口令 / 纯口令三种模式，AES-256-GCM + AAD + 固定档位填充，6 词 BIP39 口令（66 bit），PBKDF2-SHA256 600k
- 写：生成后复制链接 / 口令、系统分享；读：粘贴链接或 6 词，打开成功即请求中继焚毁；缺口令不焚毁
- 保险箱：系统 Keychain 只存 32B 密钥，条目整表 AES-GCM 加密后放 AsyncStorage；暂存与密码分栏，列表不返回密码正文；复制 45 秒后清剪贴板
- 密信 / 邮件阅读页可直接「暂存」「存入保险箱」；可分享 Markdown

**第三轮：AI 与打磨**

- 设置里配置任意 OpenAI 兼容接口（base URL / model / Key 入钥匙串）
- 阅读页 AI 摘要、AI 起草回复；写信页 AI 起草
- 平板内容限宽、嵌套 SafeArea 修正、短日期、账户色标、触感反馈、错误态
- Fly 中继地址可在设置里覆盖（默认本机部署的 Cloudflare Worker）

## 限制（v0.4 诚实清单）

- SMTP 只支持 465 隐式 TLS；Outlook / iCloud 这类只开 587 STARTTLS 的账户，发信请用 Mac 版
- 附件只显示元数据，不能下载 / 预览；写信只能纯文本，不支持富文本和内嵌图片
- HTML 阅读默认拦截远程图片；正文里的 cid: 内嵌图暂不还原
- Fly 的 link-code 在随机字节 salt 上走纯 JS PBKDF2（约 1–3 秒）；code 模式优先原生，明显更快
- 保险箱是本机的，不同步 Mac，也不直接写 Litmus；只能分享 Markdown
- 没有推送通知、离线缓存、后台同步；没有深色模式
- RFC2047 头覆盖 utf-8/latin1；GBK 头仍可能回退 latin1 显示
- 鸿蒙接入沿用 harmony/README.md，本轮未做专门验证
