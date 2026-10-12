# 林可兔移动版（LinkTo Mobile）

React Native 0.87 · 一套代码三平台：**Android / iOS / 鸿蒙（RNOH）**

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

- IMAP 账户添加（凭据入系统钥匙串：iOS Keychain / Android Keystore）
- 收件箱列表（最近 50 封 envelope）+ 正文阅读（text/plain）+ 已读回写
- 常用服务商服务器自动猜测（Gmail/QQ/163/Outlook/iCloud）

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