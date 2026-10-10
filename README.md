# LinkTo（林可兔）

AI 原生邮件工作台 —— OpenFlow 家族「林」字辈成员。

> 命名：Link 音译「林可」，to 音译「兔」——动若脱兔，取其快；「林」呼应家族品牌「林下」命名安排。

基础体验对齐 Canary Mail（多账户、统一收件箱、通知、签名、模板、规则、集成），在此之上叠加差异化方向：

- **AI 原生**：智能分类降噪（个人 / 通知 / Newsletter / 噪声）、会话摘要、AI 起草回复、提取待办
- **一键授权添加账户**：Gmail（浏览器回环授权弹窗）/ Outlook · Hotmail · M365（设备码授权），点服务商卡片 → 授权 → 自动完成，token 临期自动刷新；未配置 OAuth 凭据时降级为应用专用密码引导流程；支持构建时注入官方内置凭据（LINKTO_BUILTIN_*），分发版零配置
- **快速添加**：输入邮箱地址即自动识别服务商并进入对应流程；服务商卡片标注门槛（一键授权 / 授权码）
- **应用内分步教学**：QQ / 163 / 126 / 139 / 新浪 / 腾讯企业邮 / Yahoo / Zoho / iCloud 的授权码获取步骤逐一列出（带编号），官方设置页按钮直达；密码框智能识别粘贴内容（16 位授权码、Apple 分组专用密码等格式即时校验提示）
- **预设齐全**：Gmail / Outlook / iCloud / QQ / 163 / 126 / 139 / 新浪 / 腾讯企业邮 / 阿里云邮 / Yahoo / Zoho 等国内外主流邮箱，官方推荐的服务器 · 协议 · 端口全部预填，用户只需填邮箱和密码
- **备份与恢复**：口令加密（AES-256-GCM + scrypt）的账户配置备份文件，一键投递到 iCloud Drive / Dropbox / Proton Drive / 坚果云 / OneDrive 的本地同步目录自动云同步；新设备导入即恢复（含密码与 OAuth 令牌，可选），跨设备迁移免重复填写
- **Agent 记忆成长系统**：LinkTo 不只是一次性 AI 助手，而是日积月累的个人 Agent——
  - 从邮件中自动沉淀长期记忆（事实 / 偏好 / 人物关系 / 承诺 / 惯例），重复出现自动提升置信度
  - 记忆注入所有 AI 能力：起草回复、知识库问答、批量提问、每日商情都会参考「你是谁、你和谁、你答应过什么」
  - 发件人画像：关系总结 + 高频主题 + 我的回复率，随往来邮件持续更新
  - Agent 对话：基于长期记忆 + 知识库 + 全文检索回答「我和某人的合作到哪一步了」「我答应过谁什么还没办」
  - 全部记忆本地存储，可在 Agent 视图查看 / 编辑 / 归档
- **智能洞察**（自配 AI 驱动）：
  - 验证码邮件弹出气泡一键复制；登录 / 魔法链接邮件一键直达，不用翻正文
  - 信用卡账单、会议通知自动提炼成待办；Newsletter 自动提取文章进阅读清单
  - 每日商情：定期学习近 36 小时邮件，按主题整理 digest + 当日重点 + 备忘录 + 建议删除哪些
  - 公司洞察：按时间线剖析一家公司发来的所有邮件（运营策略 / 品牌价值可信度 / 你未来被转化的指数）
- **知识库**：一键收藏邮件为知识条目（自动打标签），支持检索与基于知识库的 AI 问答
- **Newsletter 阅读侧**：自动识别订阅邮件、订阅发件人管理、List-Unsubscribe 一键退订
- **OpenFlow 设计语言**：奶油纸底 + 环境光斑 + 玻璃拟态 + Space Grotesk，全 oklch token 驱动（移植自 OpenFlow DESIGN-SYSTEM）
- **Liquid Glass 液体玻璃**（macOS 26+ 风格）：浮层高斯模糊 + 饱和提升 + 顶部镜面高光 + 边缘折射描边；双层环境光斑缓慢漂移呼吸；指针跟随高光在玻璃表面流动；液态按钮弹簧按压回弹；支持 prefers-reduced-motion 降级
- **快速切换风格**（ThirdC 模式）：明暗 / 9 款主题预设即点即换、24 款阅读信纸皮肤独立换装
- **⌘K 命令面板**：导航 / 动作 / 邮件直达，一处入口
- **发送增强**：延迟发送（30s / 1min，可撤销）与定时发送（发件队列右下角浮条，逐条撤销；失败自动退避重试）
- **性能**：正文按需拉取——列表同步只抓信封，打开邮件时才下载正文；近期收件箱限量预取 + 旗标刷新节流
- **OpenFlow 连接器架构**：Manifest 声明式框架（鉴权 / 动作 / 事件），家族产品（OpenFlow 工作台 / inFlow / LearnFlow / MFlow / PayFlow）已按统一 Intake 协议接入

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

首次使用：设置 → 账户 → 点击 + → 直接点 **Gmail / Outlook / Hotmail / Microsoft 365** 卡片，浏览器弹窗完成授权即自动添加（OAuth 一键授权，无需输入密码；Gmail 需在「OAuth 应用凭据」里填入你的 Google OAuth 客户端，Outlook 系填入 Azure Client ID）。未配置凭据时自动降级为引导式流程：点服务商卡片 → 按提示打开官方设置页生成应用专用密码/授权码粘贴即可（Gmail / iCloud 需要应用专用密码；QQ / 163 / 139 需要授权码）。

AI 功能：设置 → AI → 选择预设（智谱 GLM / OpenAI / DeepSeek / Ollama / LM Studio），填入 API Key，测试连接。

**本地端侧模型**：点「探测本机推理服务」自动发现 Ollama（11434）/ LM Studio（1234）/ llama.cpp（8080），拉取模型列表一键选用；本地端点无需 API Key，邮件内容完全不出本机。推荐端侧小模型：`gemma3:4b`、`qwen3:4b`、`llama3.2:3b`（`brew install --cask ollama && ollama pull gemma3:4b`）。

**自定义咒语**：设置 → AI → 自定义咒语，启用的咒语会追加到所有 AI 功能的系统提示（摘要 / 起草 / 问答 / 商情 / 洞察），如「回复保持简洁正式，不超过 120 字」。

## Agent（个人 AI Agent）

侧栏「🤖 Agent」是 Agent 的成长面板：

- **记忆列表**：按 事实 / 偏好 / 人物关系 / 承诺 / 惯例 五个维度沉淀，支持搜索、编辑、归档、手动记录
- **学习邮件**：阅读窗 AI 面板 →「学习」按钮，让 Agent 从当前邮件提取值得长期记住的信息
- **自动学习**：生成「今日商情」后，Agent 会自动学习当日重点邮件
- **发件人画像**：输入邮箱或域名 → 关系总结、高频主题、我的回复率；关键事实自动沉淀为人物记忆
- **Agent 对话**：基于长期记忆 + 知识库 + 近期邮件全文检索回答，回答中会标注记忆来源 [M1] / [K2] / [E3]，并主动提出新的记忆建议

记忆如何被使用：AI 起草回复、知识库问答、多选提问、每日商情在生成时都会按相关性召回 top 记忆注入提示词——用得越多，Agent 越懂你。

## 备份与恢复（跨设备迁移）

设置 → 备份：

- **备份**：选目标（iCloud Drive / Dropbox / Proton Drive / 坚果云 / OneDrive / 任意目录）→ 设备份口令 → 生成 `LinkTo-Backup-*.lkbak`（AES-256-GCM 加密，口令经 scrypt 派生，不落盘）。放入网盘同步目录即自动云同步
- **恢复**：新设备上选择备份文件 → 输入口令 → 账户（含服务器配置、密码、OAuth 令牌，可选）即刻恢复并开始同步；已存在的账户自动跳过不重复导入
- 口令忘记无法恢复，请妥善保管

## 快速切换风格

三层换肤，全部即时生效并持久化（ThirdC 交互模式）：

| 层 | 入口 | 作用范围 |
| --- | --- | --- |
| 明暗（auto / 浅色 / 深色） | 侧栏底部 🌙 · `⌘T` · 设置 → 外观 | 整个应用 |
| 主题预设（9 款，来自 OpenFlow） | 侧栏底部 🎨 · `⌘K` → 主题预设 · 设置 → 外观 | 整个应用（token 覆盖层） |
| 阅读风格（24 款信纸皮肤） | 阅读窗右上角「风格」· `⌘K` → 阅读风格 | 仅邮件正文（Shadow DOM） |

设计系统：`src/renderer/src/styles/global.css`（OpenFlow tokens.css 移植，Tailwind 4 `@theme` 映射）；
预设数据：`src/renderer/src/lib/theme-presets.ts`；皮肤元组：`src/renderer/src/lib/reading-styles.ts`。

## 智能洞察（需自配 AI）

侧栏「✨ 智能洞察」四个 Tab，全部走 设置 → AI 里你自己配置的 OpenAI 兼容接口：

- **今日商情**：每日自动（或手动）通读近 36 小时邮件 → 当日重点、主题 digest、备忘录（可补充）、清理建议（一键删除）
- **待办**：账单（金额 / 还款日）、会议邀请自动提炼，可勾选完成、跳回原邮件
- **阅读清单**：Newsletter 文章自动收录，支持已读 / 打开链接
- **公司洞察**：选一个发件域名 → 时间线 + 运营策略剖析 + 品牌价值可信度评分 + 你的转化指数

自动化开关在 设置 → AI：自动提炼（新邮件命中账单/会议/Newsletter 特征才调 AI，控制成本）、每日商情。
单封提炼：阅读窗 AI 面板 →「提炼」。

## 架构

```
┌─ 渲染进程 (React, sandbox + contextIsolation) ──────────────┐
│  主窗口三栏：侧边栏 │ 邮件列表 │ 阅读窗（Shadow DOM 消毒渲染）│
│  设置窗口：常规/账户/通知/签名/模板/规则/AI/集成              │
└─────────────── contextBridge + 类型化 IPC ──────────────────┘
┌─ 主进程 (Node/TS) ──────────────────────────────────────────┐
│  SyncEngine：每账户一个 IMAP worker（增量 UID + 存活轮询）    │
│  MailStore：SQLite（邮件/线程/文件夹/附件 + FTS5）           │
│  AIService / AgentService（长期记忆）/ Notifier / RuleEngine │
│  ConnectorHost                                              │
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

家族产品（OpenFlow 工作台 / inFlow / LearnFlow / MFlow / PayFlow）已内置：产品侧只需暴露一个 Intake HTTP 入口，
在 设置 → 集成 里填入 endpoint + API Key 连接；阅读窗的「分享」菜单即可把邮件内容发过去
（`POST {product, action, payload}`，鉴权走 `X-Api-Key`）。新增连接器在 `src/main/connectors/builtin.ts`
注册一个 `BuiltinConnector`（Manifest + 执行器），设置页会自动出现对应卡片。

## 快捷键

```
⌘K 命令面板   ⌘N 写邮件   ⌘F 搜索   ⌘T 明暗切换   ⌘R 刷新   ⌘, 设置
J/K 下一封/上一封   R 回复   A 归档   ⌫ 删除
```

## 目录

```
src/shared/       类型契约（types.ts / ipc.ts / presets.ts）
src/main/         主进程（db / mail / ai: service·insights·agent / rules / connectors / ipc / notify）
src/preload/      contextBridge API 表
src/renderer/     主窗口 + 设置窗口（React）
                  ├ styles/global.css   OpenFlow 设计系统（tokens + Tailwind 4 映射）
                  └ lib/                theme.ts · theme-presets.ts · reading-styles.ts
scripts/          冒烟测试 / 演示数据 / 截图工具
```
