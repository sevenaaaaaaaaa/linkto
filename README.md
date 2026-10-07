# Mail Studio

AI 原生邮件工作台 —— LinKTo / OpenFlow 家族的邮件客户端。

基础体验对齐 Canary Mail（多账户、统一收件箱、通知、签名、模板、规则、集成），在此之上叠加三个差异化方向：

- **AI 原生**：智能分类降噪（个人 / 通知 / Newsletter / 噪声）、会话摘要、AI 起草回复、提取待办
- **知识库**：一键收藏邮件为知识条目（自动打标签），支持检索与基于知识库的 AI 问答
- **Newsletter 阅读侧**：自动识别订阅邮件、订阅发件人管理、List-Unsubscribe 一键退订
- **OpenFlow 连接器架构**：Manifest 声明式框架（鉴权 / 动作 / 事件），家族产品后续按此接入

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Electron 44 + electron-vite 5 + electron-builder |
| UI | React 18 + TypeScript + Tailwind CSS 4 + zustand + TipTap |
| 邮件协议 | imapflow（收信 / IDLE）· nodemailer（发信）· mailparser（MIME） |
| 本地数据 | Electron 内置 `node:sqlite`（WAL + FTS5 trigram 中文检索），零原生编译 |
| 凭证 | electron `safeStorage`（系统钥匙串级加密） |
| AI | OpenAI 兼容接口（GLM / OpenAI / DeepSeek / Ollama 均可），流式输出 |

## 快速开始

```bash
npm install
npm run dev        # 开发模式
npm run dist       # 打包 dmg（electron-builder）
```

首次使用：设置 → 账户 → 添加你的第一个邮箱。
Gmail / iCloud 需要应用专用密码；QQ / 163 / 139 需要授权码（各服务商设置页有引导说明）。

AI 功能：设置 → AI → 选择预设（智谱 GLM / OpenAI / DeepSeek / Ollama），填入 API Key，测试连接。

## 架构

```
┌─ 渲染进程 (React, sandbox + contextIsolation) ──────────────┐
│  主窗口三栏：侧边栏 │ 邮件列表 │ 阅读窗（Shadow DOM 消毒渲染）│
│  设置窗口：常规/账户/通知/签名/模板/规则/AI/集成              │
└─────────────── contextBridge + 类型化 IPC ──────────────────┘
┌─ 主进程 (Node/TS) ──────────────────────────────────────────┐
│  SyncEngine：每账户一个 IMAP worker（增量 UID + 存活轮询）    │
│  MailStore：SQLite（邮件/线程/文件夹/附件 + FTS5）           │
│  AIService / Notifier / RuleEngine / ConnectorHost          │
└─────────────────────────────────────────────────────────────┘
```

安全设计：邮件 HTML 在 Shadow DOM 中消毒渲染（去脚本/事件属性），远程图片默认拦截（可单封放行），链接走系统浏览器，密码经 safeStorage 加密落盘，渲染进程全沙箱。

## 开发脚本

```bash
node scripts/smoke.mjs            # IPC 全链路冒烟测试（需应用运行在 :9224 调试端口）
node scripts/seed-demo.mjs        # 向运行中的应用注入演示邮件
node scripts/cdp-shot-only.mjs    # CDP 截图（需 --remote-debugging-port=9224）
```

## 接入 OpenFlow 家族连接器

在 `src/main/connectors/builtin.ts` 中注册一个 `BuiltinConnector`（Manifest + 执行器），
设置 → 集成 页会自动出现对应卡片；阅读窗的「分享」菜单即可把邮件内容发给该连接器。

## 目录

```
src/shared/       类型契约（types.ts / ipc.ts / presets.ts）
src/main/         主进程（db / mail / ai / rules / connectors / ipc / notify）
src/preload/      contextBridge API 表
src/renderer/     主窗口 + 设置窗口（React）
scripts/          冒烟测试 / 演示数据 / 截图工具
```
