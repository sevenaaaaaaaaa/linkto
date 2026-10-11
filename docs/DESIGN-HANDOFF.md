# DESIGN-HANDOFF — Mail Studio 交互 / UI / 配色重设计交接文档

> 交接对象：接手本应用视觉与交互升级的工程师（人类或 AI）。
> 交接口径来自产品所有者的原话，三条优先级从高到低，**不可颠倒**：

## 0. 产品定位（所有设计决策的裁判）

1. **首先**，她是一个**多账户邮件管理、海量邮件中快速获取有效信息、面向重度邮件使用者**的优秀邮件应用。交互必须丝滑、不复杂。
2. **其次**，她**不重走传统邮件应用走过的路**。差异化在于用 **AI / AI Agent / MCP** 快速实现以前邮件应用做不到的「与其他场景的连接与洞察」（邮件→任务→知识→公司情报→自动化）。
3. **最后，她必须好看——像一个工艺品（craft object）**。

对第 3 条的可操作解释（ owner 已确认对表）：
- 工艺感 = 克制 + 精确 + 一致性，**不是**装饰堆砌。参照物气质：Things 3 的安静、Linear 的密度与锐度、Arc 的材质实验、Raycast 的键盘节奏。
- 现状的主要病症是「功能很多但入口分散、密度不均、配色平庸」，不是缺功能。

---

## 1. 现状全景（2026-10-11，main @ 7a62fc2）

### 技术栈
- Electron 44 + electron-vite 5 + React 18 + **Tailwind CSS 4**（`@theme` in CSS，无 tailwind.config）+ zustand + TipTap
- 渲染进程沙箱 + CSP：`style-src 'self' 'unsafe-inline'`，字体/图片仅 self/data —— **一切资源必须自托管**（`src/renderer/public/`，已有 Space Grotesk / JetBrains Mono woff2）
- 图标：`src/renderer/src/components/icons.tsx` 手写 24×24 stroke SVG（strokeWidth 1.8），无图标库依赖

### 设计系统现状（在 `src/renderer/src/styles/global.css`）
- **Token 层**：全 oklch 变量（`--bg / --bg-soft / --surface / --surface-strong / --fg / --muted / --faint / --border(-strong/-soft) / --hover(-strong) / --accent(-strong/-soft) / --on-accent / --ok / --warn / --danger / --glass* / --blob-a/b/c / --shadow(-sm) / --r-lg 26px / --r-md 18px / --r-sm 12px`），源自 OpenFlow tokens.css 的「暖奶油纸底」体系
- **Tailwind 映射**：`@theme` 里 zinc-* 全系重映射为暖灰、blue-* → accent、orange → warn；**深色模式**与主题预设通过 `[data-theme='dark']` 内反转 zinc/blue 实现——组件层无需感知明暗
- **签名元素**：`body::before` 三团 radial 环境光斑（`--blob-*`）、`.glass / .glass-strong`（backdrop-filter 玻璃）、`--ease-spring: cubic-bezier(.32,.72,0,1)` 弹簧缓动、`.pop-in / .fade-in / .shimmer`
- **主题引擎**（`lib/theme.ts` + `lib/theme-presets.ts`）：明暗三层换肤——`data-theme` 属性 / 9 套预设（注入 `#theme-override` 覆盖 token）/ 24 款阅读信纸皮肤（只作用于正文 Shadow DOM）。**任何新样式都必须同时过明暗两态**
- **Liquid Glass**（`lib/liquid-glass.ts` + interactions.tsx）：对齐 Apple WWDC25 材质——SVG 位移滤镜真折射、浮层 morph、`prefers-reduced-transparency / reduced-motion` 降级链已建好

### 已有功能面（信息架构现状 = 你要整理的对象）
- **主窗口三栏**：Sidebar(248px) / MessageList(380px) / Reader(flex)
- **侧栏视图入口（9+）**：统一收件箱、已加旗标、个人邮件、通知、Newsletter、噪声、📌置顶、🕐稍后处理、🛡待审批、↩待跟进、智能洞察、知识库、Agent、各账户文件夹、我的视图（Smart Views）、🎨主题、🌙明暗
- **列表工具条（3 层！）**：搜索框行 / 全选+标题+会话+排序+双轨+存视图+AI整理行 / 过滤chips行（9枚）+时光机 / 重力滑块行 —— **这是密度失控的重灾区**
- **列表交互**：行悬停快捷胶囊（📌⏰归档旗标删除/待审✓✕）、Shift 范围选、多选 BulkBar（14 个按钮）、会话折叠、重力混合排序、时光机倒带、波纹批量、View Transitions、液态重排
- **Reader**：工具栏（回复/全部回复/转发/⏰稍后/📌置顶/旗标/归档/删除/存知识库/分享/风格/标未读）+ 验证码/登录气泡 + AI 助手面板（摘要/起草/提炼/提取待办）+ 附件卡 + 正文卡（24 款信纸皮肤）
- **其他窗口**：撰写窗（发送▾延迟/定时菜单）、设置窗（账户/AI/备份/集成/规则/签名/模板/通知/外观…）、⌘K 命令面板、AI 搜索（问句→结构化查询）、Smart Views、每日商情、公司洞察（时间线+可信度+转化指数）、待办清单、阅读清单、Agent 视图
- **AI 面**：本地引擎（node-llama-cpp，仅轻任务）/ 云端 API 预设 / Ollama+LM Studio 本地部署；全部结构化 prompt 集中在 `src/main/ai/prompts.ts`（**语义勿动**）

### 主进程/数据（UI 改动者只需知道存在）
- SQLite（node:sqlite + FTS5 trigram 中文检索）、IMAP/SMTP 同步引擎（含 OAuth）、断网操作队列、发件队列（延迟/定时）、Snooze 定时释放、Screener 发件人筛选、网盘 eml 备份、Agent 记忆/联系人画像、MCP server、OpenFlow 家族连接器

---

## 2. 已知问题清单（owner 的不满点）

1. **信息架构过载**：侧栏入口 14+，列表工具条 3~4 层，BulkBar 14 按钮，Reader 工具栏 12+ 动作 —— 「不复杂」这条及格线目前不达标。需要做**信息架构收敛**：视图分组/降级、工具条合并、次级动作进溢出菜单（⌘K 已存在，可承接更多入口）
2. **配色平庸**：奶油底 + 单蓝 accent 体系工整但无个性，与「工艺品」预期有差距。重设计应在 token 层引入更有气质的配色（倾向：更沉稳的中性底 + 一个高辨识度 accent + 语义色微调），**同时保住明暗双态与主题预设引擎**
3. **密度不均**：列表行/卡片/按钮的间距节奏没有严格网格；字号层级依赖临时值（text-[13.5px] 等散落各处）——需要建立并落地一套 type/spacing scale
4. **材质表现参差**：Liquid Glass 与普通 glass 并存，部分弹层仍是旧 shadow 卡片；需要统一材质策略（何时玻璃、何时实底、何时液态）
5. **首屏气质**：空状态/占位/图标语言偏「工程师审美」，缺乏工艺品般的细节（微动效、层次、呼吸感）

---

## 3. 改造建议路线（供参考，非硬性）

1. **Phase A — 设计审计**：用 CDP 把全部视图截图（明/暗 × 主要 scope × 设置窗），产出问题清单与目标风格板（建议明确到「色板 token 值 / 字号表 / 间距表 / 圆角与描边规范 / 材质使用规则 / 动效曲线」六个交付物，全部落到 global.css）
2. **Phase B — 信息架构收敛**：侧栏分区重组（核心收件箱 / 纪律队列收纳为一组 / 智能面收纳为一组）、列表工具条合并为单行 + 溢出、BulkBar 精简为高频 4 + 溢出、Reader 动作分组
3. **Phase C — token 层重设计**：配色/字号/间距/材质全部在 global.css 落地，组件层只换类名不写死颜色；逐视图截图验收
4. **Phase D — 微工艺**：焦点环、选中态、空状态、骨架屏、过渡曲线、图标对齐 1px 级修整

## 4. 验证闭环（每次改动后）

```bash
npm run typecheck            # 双 tsconfig
npm run build                # 生产构建
npx electron . --remote-debugging-port=9224 &   # 启动（首窗出现需 9~12s，耐心等）
node scripts/cdp-shot-only.mjs /tmp/xxx.png     # 截图核验（支持第二参数 settings 打开设置窗）
```
- 人工核验点：明/暗两态、主题预设切换后无残留、玻璃层文字对比度、380px 列表在 narrow 断点不溢出
- 若应用静默退出：删除 `~/Library/Application Support/linkto/Singleton*` 再启动（陈旧单例锁的已知问题）
- 运行数据在 `~/Library/Application Support/linkto/`——**真实用户数据，严禁删除**

## 5. 禁改清单

- `src/main/**` 业务逻辑、`src/shared/ipc.ts` 既有签名（可增不可改）、`src/main/ai/prompts.ts` 提示词语义
- `src/main/ai/prompts.ts` 之外的 AI 行为逻辑（模型策略刚定稿：结构化功能走 API / 本地部署 7B+，内置 4B 仅轻任务）
- 数据库 schema / 迁移逻辑
- 现有快捷键语义（⌘K/⌘T/⌘N/⌘F/⌘R/J/K/R/A/S/⌫）除非做整体键盘方案设计

## 6. 品质基线（每次交付自查）

- [ ] 明暗两态 + 至少 2 套主题预设下截图核对
- [ ] 颜色全部来自 token（grep 组件内 `#[0-9a-f]{3,6}` 应为 0 命中，白/黑除外）
- [ ] 动效遵守 `prefers-reduced-motion` 与既有 `--ease-spring / --ease-out`
- [ ] 列表 380px / narrow 断点无溢出、无文字截断异常
- [ ] 键盘可达性：新入口可在 ⌘K 中触达
- [ ] typecheck + build 通过 + 截图核验留档
