# 鸿蒙（HarmonyOS）接入指南 — RNOH

React Native for OpenHarmony（RNOH）是 OpenHarmony 官方维护的 RN 适配层，已在国内主流应用验证。
当前工程为标准 RN 0.87，接入 RNOH 后 `src/` 下的全部业务代码（ImapLite / store / screens）零改动复用。

## 前置（需手动完成，命令行无法安装）

1. 安装 **DevEco Studio**（华为开发者官网下载，含 HarmonyOS SDK）
2. DevEco 内完成 HarmonyOS NEXT 模拟器或真机签名配置

## 接入步骤（工程侧）

RNOH 仓库：`https://github.com/react-native-ohoh/react-native-oh`（跟随 RN 0.7x 分支版本表）

1. 在 `harmony/` 新建 DevEco 工程（entry 模块），把 RNOH HAR 依赖加入 `oh-package.json5`
2. `RnAppShell.ets` 中挂载 RNOH 实例，加载 RN bundle
3. **原生模块替换清单**（RNOH 需要对应鸿蒙实现或 JS 替代）：
   - `react-native-tcp-socket` → 鸿蒙侧用 `@ohos.net.socket`（TLS）实现同接口，或使用社区 `rnoh-tcp` 适配包
   - `react-native-keychain` → 鸿蒙 `@ohos.security.asset`（资产存储）适配
   - `@react-native-async-storage/async-storage` → RNOH 社区已有鸿蒙适配包
   - `zustand` → 纯 JS，直接可用
4. Metro 打包 bundle：`npx react-native bundle --platform harmony --dev false --entry-file index.js --bundle-output harmony/entry/src/main/resources/rawfile/index.android.bundle`（RNOH 复用 android bundle）

## 建议顺序

先跑通 DevEco Hello World（验证工具链）→ RNOH 空应用渲染 RN 组件 → 逐个替换上面 4 个原生模块 → ImapLite 联调。

工具链装好后把本目录补全为真实 DevEco 工程即可。