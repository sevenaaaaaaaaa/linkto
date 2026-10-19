# CLAUDE.md — Mail Studio (LinkTo)

> AI 原生邮件工作台 · LinKTo / OpenFlow 家族。仓库 `github.com/sevenaaaaaaaaa/linkto`；本地唯一工作目录 `~/LinkTo`（旧的嵌套克隆 `~/LinkTo/mail-studio/` 已弃用，勿在其中开发或发版）。

## 接手必读

**做任何 UI/交互/配色工作前，先完整阅读 `ops/design/DESIGN-HANDOFF.md`**（仅本地，`ops/` 已 gitignore，不进 GitHub）—— 那是产品定位、现状全景、设计约束与验证方法的唯一权威交接文档。设计审计 `ops/design/DESIGN-AUDIT.md` 与审计截图 `ops/design/audit/` 同样只在本地。

过程性文档（审计、交接、截图、待办、复盘）一律放 `ops/`，不进公开仓库；面向用户的版本说明只写根目录 `CHANGELOG.md`。

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

## 发版（Nightly + 正式版本）

版本号唯一来源：根目录 `package.json` 的 `version`（`package-lock.json` 随 `npm version` 同步）。`mobile/` 独立编号（`mobile/package.json`、Android `versionName`、iOS `MARKETING_VERSION` 三处一致，见 `mobile/README.md`），不随桌面版发包。

**每日构建（Nightly）**：每天开发结束跑一次（或由全局 launchd 调度 `~/.local/bin/daily-release-all.sh`）。

```bash
scripts/daily-release.sh               # 构建并刷新 GitHub 上唯一的 nightly 预发布
scripts/daily-release.sh --dry-run     # 只在本地构建打包并校验 DMG，不打 tag/推送/发 Release/安装
scripts/daily-release.sh --no-install  # 不替换 /Applications/LinkTo.app
scripts/daily-release.sh --force       # nightly tag 已在 HEAD 也重新构建
```

流程：必须在 `main`、工作区干净（脏则打印并以 0 退出「skipped」，绝不自动提交 WIP）、与 origin 同步（落后则 `pull --rebase --autostash`，冲突即失败；本地领先则跳过，先自己 push）→ `npm run typecheck` → `nightly` tag 已指向 HEAD 且 Release 已完成则跳过 → 版本号**只注入构建、从不提交**：下一个次版本 + `-nightly.YYYYMMDD`（`package.json` 为 0.3.3 时是 `0.4.0-nightly.20261014`，排在所有 0.3.x 之后、正式 0.4.0 之前；经 `electron-builder -c.extraMetadata.version` 写入安装包，Info.plist / Windows 文件版本用纯数字 `0.4.0`）→ mac dmg + win nsis + linux AppImage → 校验 DMG 内含打开助手 → 强制移动 tag `nightly` 到 HEAD 并 `push -f` → 更新唯一的预发布 `nightly`（标题「Nightly · YYYY-MM-DD」，`--prerelease --latest=false`，说明 = 上个正式 `v*` 以来的提交标题 + 安装提示，资产 `--clobber` 覆盖并删除旧 nightly 资产）→ 优雅退出本机 LinkTo、`ditto` 替换 `/Applications/LinkTo.app`、去隔离、原先在运行则重开。单实例锁；失败直接重跑即可续上（Release 说明里记录了所构建的提交）。最后一行固定输出 `RESULT: built nightly <版本> <sha>` / `RESULT: skipped <原因>` / `RESULT: failed <原因>`，供全局调度脚本判定。日志：`~/Library/Logs/linkto-daily-release.log`。无 CI，资产全部来自本机构建。

**正式版本**：只发主版本 `X.Y.0`（`X.Y.Z` 仅用于正式版的紧急修复）。先在 `CHANGELOG.md` 写好 `## X.Y.0 — YYYY-MM-DD · 主题`（补丁写 `### X.Y.Z — 日期  修复：…`）并提交，然后：

```bash
scripts/release.sh 0.4.0 --dry-run   # 预览从 CHANGELOG 提取的发布说明
scripts/release.sh 0.4.0             # bump package.json → chore(release): v0.4.0 + 附注 tag → 构建 → push → gh release create --latest
```

macOS 打开助手：DMG 内含 `LinkTo.app`、`Applications` 链接、`打不开？双击我.command`、`安装说明.txt`（由 `electron-builder.yml` 的 `dmg.contents` 打入，模板在 `packaging/macos/`）。安装包未签名/未公证（本机只有 Apple Development 证书），`.command` 会移除 `com.apple.quarantine`、签名校验失败时做 ad-hoc 重签，然后打开应用，避免「已损坏，无法打开」。

本机签名身份（钥匙串授权跨版本保留）：ad-hoc 签名每次构建都变，macOS 会在每次装新版后重新询问「linkto Safe Storage」钥匙串授权。运行一次 `scripts/setup-signing.sh`（在登录钥匙串里创建自签名代码签名身份「LinkTo Local Signing」，需本人输入登录密码；`--check` 查看状态、`--remove` 撤销）后，`daily-release.sh` / `release.sh` 会自动用它签名（`scripts/lib/mac-signing.sh`；没有该身份时仍是 ad-hoc 并在日志里提示），装新版后再点一次「始终允许」即可长期有效。应用启动不再同步读钥匙串：先开窗，密钥在后台解锁，授权对话框未处理时界面给出中文说明。
