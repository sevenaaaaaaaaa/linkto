# 林可兔移动版（LinkTo Mobile）

React Native 0.87 · 一套代码三平台：**Android / iOS / 鸿蒙（RNOH）**

> 版本：移动版独立编号，与桌面版（仓库根 `package.json`）不同步，也不随桌面版的 Nightly / 正式 Release 发包。当前 0.3.0，
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
- **阶梯焚毁**（密码）：错 5 次锁 15 分钟（每 5 次翻倍：15m→30m→60m…），累计 15 次 → 焚毁钥匙串主密钥/全部账户凭据/本地账户索引，物理不可恢复
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

## 限制（v0.1 诚实清单）

- 正文为 text/plain 近似；HTML 富文本渲染计划 v0.2
- RFC2047 解码覆盖 utf-8/latin1；GBK 编码头（部分国内服务商）暂回退 latin1 显示
- 未支持：文件夹切换、附件、发送、SMTP、幽灵信