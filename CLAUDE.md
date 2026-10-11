# CLAUDE.md — Mail Studio (LinkTo)

> AI 原生邮件工作台 · LinKTo / OpenFlow 家族。仓库 `github.com/sevenaaaaaaaaa/mail-studio`。

## 接手必读

**做任何 UI/交互/配色工作前，先完整阅读 [`docs/DESIGN-HANDOFF.md`](docs/DESIGN-HANDOFF.md)** —— 那是产品定位、现状全景、设计约束与验证方法的唯一权威交接文档。

## 快速命令

```bash
npm run typecheck   # 双 tsconfig 全量类型检查（改动后必跑）
npm run build       # 生产构建
npm run dist        # 打包 macOS dmg（electron-builder，未签名自用）
npm run dev         # 开发模式
node scripts/cdp-shot-only.mjs /tmp/shot.png   # CDP 截图（需先 npx electron . --remote-debugging-port=9224）
```

## 硬性红线

1. 不改 `src/main/`（业务逻辑层）除非任务明确要求；`src/shared/ipc.ts` 是主/渲染契约，只增不改
2. `src/main/ai/prompts.ts` 是全部 AI 提示词的唯一来源，语义不要动
3. 渲染进程有 CSP 限制：无外部字体/图片/脚本，一切资源自托管（`src/renderer/public/`）
4. UI 改动必须走 `src/renderer/src/styles/global.css` 的 token 层（oklch 变量 + Tailwind 4 `@theme` 映射），禁止在组件里散写颜色
5. 深色模式与 9 套主题预设靠 `[data-theme]` + token 覆盖层驱动，新样式必须同时适配两层
6. 验证闭环：typecheck → build → 启动应用 → CDP 截图人工核验（当前机器启动慢，等 9~12s；`~/Library/Application Support/linkto/` 是运行时数据，勿删勿改）
