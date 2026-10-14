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

## 发版（每日）

**规则：每天开发结束必须跑一次 daily-release（或由 launchd 自动跑）。**

```bash
scripts/daily-release.sh             # 正式发版
scripts/daily-release.sh --dry-run   # 只在本地构建打包并校验 DMG，不提交/打 tag/推送/发 Release/安装
scripts/daily-release.sh --no-install  # 发版但不替换 /Applications/LinkTo.app
scripts/daily-release.sh --force     # 自上个 v* tag 以来无新提交也强制发版
```

流程：必须在 `main` 且工作区干净（脏则打印并以 0 退出「skipped」，绝不自动提交 WIP）→ `git fetch` + `git pull --rebase --autostash`（冲突则 abort 并失败退出）→ `npm run typecheck` → 无新提交则跳过 → patch 版本号 +1（`package.json` + `package-lock.json`；`mobile/` 独立版本不动）→ `npm run dist`（mac dmg + win nsis + linux AppImage）→ 校验 DMG 内容 → 提交 `chore(release): vX.Y.Z` + 附注 tag → 推送 main 与 tag → `gh release create`（说明为上个 tag 以来的提交标题，上传 dmg/exe/AppImage；Release 已存在时只补缺失资产、不覆盖）→ 优雅退出本机 LinkTo、用 `ditto` 替换 `/Applications/LinkTo.app`、去隔离标记、原先在运行则重新打开。若上次已打 tag 但未发布，会自动续传。日志：`~/Library/Logs/linkto-daily-release.log`。无 CI，Release 资产全部来自本机构建。

macOS 打开助手：DMG 内含 `LinkTo.app`、`Applications` 链接、`打不开？双击我.command`、`安装说明.txt`（由 `electron-builder.yml` 的 `dmg.contents` 打入，模板在 `packaging/macos/`）。安装包未签名/未公证（本机只有 Apple Development 证书），`.command` 会移除 `com.apple.quarantine`、签名校验失败时做 ad-hoc 重签，然后打开应用，避免「已损坏，无法打开」。
