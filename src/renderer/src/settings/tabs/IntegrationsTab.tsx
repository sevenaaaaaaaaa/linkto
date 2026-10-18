import { IconCloud } from '../../components/icons'
import { useEffect, useState } from 'react'
import { api, useMailEvent } from '../../lib/api'
import { SectionTitle, Toggle } from './GeneralTab'
import type { CloudDriveConfig, CloudDriveKind, ConnectorInstance, ConnectorManifest } from '@shared/types'

/** 集成页：连接器卡片式管理（对齐 Canary 集成交互），OpenFlow 家族产品将从这里接入 */
export function IntegrationsTab() {
  const [manifests, setManifests] = useState<ConnectorManifest[]>([])
  const [instances, setInstances] = useState<ConnectorInstance[]>([])
  const [configuring, setConfiguring] = useState<ConnectorManifest | null>(null)
  const [toast, setToast] = useState('')
  const [userList, setUserList] = useState<{ id: string; name: string; error?: string }[]>([])
  const [importText, setImportText] = useState('')
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const reload = async () => {
    const [m, i, u] = await Promise.all([api.listConnectorManifests(), api.listConnectorInstances(), api.listUserConnectors()])
    setManifests(m)
    setInstances(i)
    setUserList(u)
  }
  useEffect(() => void reload(), [])
  useMailEvent(ev => {
    if ((ev as { type: string }).type === 'connectors-changed') void reload()
  })

  const showToast = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(''), 2500)
  }

  const instanceOf = (manifestId: string) => instances.find(i => i.manifestId === manifestId)

  const doInstall = async () => {
    if (!importText.trim()) return
    const res = await api.installUserConnector(importText)
    if (res.ok) {
      setImportText('')
      setImportMsg({ ok: true, text: `已安装${res.id ? `：${res.id}` : ''}，在下方列表点「连接」完成配置` })
      await reload()
    } else {
      setImportMsg({ ok: false, text: res.error ?? '安装失败' })
    }
  }

  return (
    <div className="max-w-[680px] relative">
      <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] divide-y divide-ink/[0.04]">
        {manifests.map(m => {
          const inst = instanceOf(m.id)
          return (
            <div key={m.id} className="px-5 py-4 flex items-center gap-4">
              <span
                className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
                style={{ background: `${m.color}18` }}
              >
                {m.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-zinc-800">{m.name}</span>
                  {inst && <span className="text-2xs px-1.5 py-px rounded-sm bg-green-100 text-green-600">已连接</span>}
                </div>
                <div className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{m.description}</div>
              </div>
              {inst ? (
                <button
                  onClick={async () => {
                    await api.disconnectConnector(inst.id)
                    await reload()
                    showToast(`已断开 ${m.name}`)
                  }}
                  className="text-xs px-3.5 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 shrink-0"
                >
                  断开
                </button>
              ) : (
                <button
                  onClick={() => setConfiguring(m)}
                  className="text-xs px-4 py-1.5 rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 shrink-0"
                >
                  连接
                </button>
              )}
            </div>
          )
        })}
      </div>

      <SectionTitle>自定义连接器</SectionTitle>
      <div className="text-xs text-zinc-500 mb-2">粘贴一份声明式 JSON Manifest 即可接入任意系统（声明式、不执行代码）：一个 Intake HTTP 入口 + 动作清单，安装后与其他连接器一样在阅读窗一键调用。</div>
      <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] px-4 py-3">
        <textarea
          value={importText}
          onChange={e => setImportText(e.target.value)}
          rows={6}
          placeholder='{"id":"my-notion","name":"我的 Notion","description":"…","auth":"apiKey","headerName":"X-Api-Key","endpoint":"https://…/intake","actions":[{"id":"save-email","name":"存入 Notion"}]}'
          className="w-full text-xs bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06] resize-y font-mono leading-relaxed"
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={doInstall}
            disabled={!importText.trim()}
            className="text-xs px-3.5 py-1.5 rounded-lg bg-blue-600 text-on-accent hover:bg-blue-700 disabled:opacity-40"
          >
            安装
          </button>
          <button
            onClick={async () => setImportText(await api.getUserConnectorTemplate())}
            className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
          >
            填入示例
          </button>
          {importMsg && <span className={`text-xs ${importMsg.ok ? 'text-green-600' : 'text-red-500'}`}>{importMsg.text}</span>}
        </div>
        {userList.length > 0 && (
          <div className="mt-3 divide-y divide-ink/[0.04] border-t border-ink/[0.04]">
            {userList.map(u => (
              <div key={u.id} className="py-2 flex items-center gap-3">
                <span className="text-sm text-zinc-700">{u.name}</span>
                {u.error ? (
                  <span className="text-xs text-red-500 flex-1">{u.error}</span>
                ) : (
                  <span className="text-xs text-zinc-400 flex-1 font-mono">{u.id}</span>
                )}
                <button
                  onClick={async () => {
                    await api.removeUserConnector(u.id)
                    await reload()
                    showToast(`已卸载 ${u.name}`)
                  }}
                  className="text-xs text-zinc-400 hover:text-red-500 shrink-0"
                >
                  卸载
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <SectionTitle>关于 OpenFlow 生态</SectionTitle>
      <div className="text-xs leading-relaxed text-zinc-500 bg-zinc-100/70 rounded-xl px-4 py-3">
        这里是 OpenFlow 家族的连接入口。每个连接器声明自己的鉴权方式与动作，LinkTo
        在阅读邮件时即可把内容一键分享到对应产品：需求邮件转 inFlow 任务、账单归档进 PayFlow、
        资料收藏到 LearnFlow、正文沉淀为 MFlow 笔记、纪要发往 OpenFlow 工作台。
        家族产品侧只需暴露一个 Intake HTTP 入口（endpoint + X-API-Key）即可完成对接；
        任何支持 Incoming Webhook 的外部工具也可以用「通用 Webhook」打通。
      </div>

      {configuring && (
        <ConnectorConfigDialog
          manifest={configuring}
          onClose={() => setConfiguring(null)}
          onSaved={async () => {
            setConfiguring(null)
            await reload()
            showToast(`已连接 ${configuring.name}`)
          }}
        />
      )}

      <CloudDrivesSection />

      <McpSection onToast={showToast} />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-ink/90 text-app text-sm shadow-[var(--shadow-float)] fade-in">
          {toast}
        </div>
      )}
    </div>
  )
}

function ConnectorConfigDialog(props: { manifest: ConnectorManifest; onClose(): void; onSaved(): void }) {
  const { manifest: m } = props
  const [config, setConfig] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const connect = async () => {
    setBusy(true)
    setError('')
    const res = await api.connectConnector(m.id, config)
    setBusy(false)
    if (res.ok) props.onSaved()
    else setError(res.error ?? '连接失败')
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center" onClick={props.onClose}>
      <div className="w-[440px] bg-white rounded-2xl shadow-[var(--shadow-float)] overflow-hidden fade-in" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3 border-b border-ink/[0.05]">
          <span className="w-9 h-9 rounded-xl flex items-center justify-center text-md" style={{ background: `${m.color}18` }}>
            {m.icon}
          </span>
          <div>
            <div className="text-base font-semibold text-zinc-800">连接 {m.name}</div>
            <div className="text-xs text-zinc-400">
              {m.auth === 'webhook' ? 'Webhook 鉴权' : m.auth === 'apiKey' ? 'API Key 鉴权' : '无需鉴权'}
            </div>
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          {(m.settingsFields ?? []).map(f => (
            <div key={f.key}>
              <label className="block text-xs text-zinc-600 mb-1">
                {f.label}
                {f.required && <span className="text-red-400"> *</span>}
              </label>
              {f.type === 'textarea' ? (
                <textarea
                  value={config[f.key] ?? ''}
                  onChange={e => setConfig({ ...config, [f.key]: e.target.value })}
                  className="w-full text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06] resize-none h-20"
                  placeholder={f.label}
                />
              ) : (
                <input
                  value={config[f.key] ?? ''}
                  onChange={e => setConfig({ ...config, [f.key]: e.target.value })}
                  className="w-full text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06] font-mono"
                  placeholder={f.type === undefined && f.key === 'url' ? 'https://…' : f.label}
                />
              )}
            </div>
          ))}
          {m.actions.length > 0 && (
            <div className="text-xs text-zinc-400">
              连接后可用动作：{m.actions.map(a => a.name).join('、')}
            </div>
          )}
          {error && <div className="text-xs text-red-500">{error}</div>}
        </div>
        <div className="px-5 py-3.5 border-t border-ink/[0.05] flex justify-end gap-2">
          <button onClick={props.onClose} className="text-sm px-3.5 py-2 rounded-xl text-zinc-500 hover:bg-ink/5">
            取消
          </button>
          <button
            onClick={connect}
            disabled={busy}
            className="text-sm font-medium px-4 py-2 rounded-xl bg-blue-600 text-on-accent hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? '连接中…' : '连接'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 网盘备份：WebDAV（NAS/Nextcloud/Alist/坚果云）+ Dropbox + 本地同步目录（Proton Drive 等），保存 eml 原文与附件 */
const DRIVE_KIND_LABEL: Record<CloudDriveKind, string> = {
  webdav: 'WebDAV / NAS',
  dropbox: 'Dropbox',
  local: '本地同步目录'
}

function CloudDrivesSection() {
  const [drives, setDrives] = useState<CloudDriveConfig[]>([])
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<CloudDriveKind>('webdav')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [remotePath, setRemotePath] = useState('/LinkTo')
  const [localPath, setLocalPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // Proton Drive 预设：检测到的同步目录（多账户时可切换）；null = 未检测
  const [protonFolders, setProtonFolders] = useState<{ path: string; account: string }[] | null>(null)
  const [protonUrl, setProtonUrl] = useState('')

  const pickLocal = async () => {
    const dir = await api.pickDirectory('选择网盘的本地同步目录')
    if (dir) setLocalPath(dir)
  }

  // 一键 Proton Drive：检测同步目录并预填；未安装则给出下载引导
  const presetProton = async () => {
    setKind('local')
    setMsg(null)
    const res = await api.detectProtonDrive()
    setProtonFolders(res.folders)
    setProtonUrl(res.downloadUrl)
    if (res.folders.length) {
      setLocalPath(res.folders[0].path)
      if (!name.trim()) setName('Proton Drive')
    }
  }

  const reload = async () => setDrives(await api.listCloudDrives())
  useEffect(() => void reload(), [])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    const isLocal = kind === 'local'
    const res = await api.saveCloudDrive(
      { id: '', kind, name, url: isLocal ? '' : url, username: isLocal ? '' : username, remotePath, localPath: isLocal ? localPath : undefined },
      isLocal ? '' : secret
    )
    setBusy(false)
    if (res.ok) {
      setMsg({ ok: !res.error, text: res.error ?? `已保存并通过连接测试：${name}` })
      setName('')
      setUrl('')
      setUsername('')
      setSecret('')
      setLocalPath('')
      setProtonFolders(null)
      await reload()
    } else {
      setMsg({ ok: false, text: res.error ?? '保存失败' })
    }
  }

  return (
    <>
      <SectionTitle>网盘备份</SectionTitle>
      <div className="text-xs text-zinc-500 mb-2">
        把邮件 eml 原文与附件存到你自己的网盘 / NAS：支持 WebDAV（群晖、威联通、Nextcloud、Alist、坚果云等）、
        Dropbox，以及本地同步目录（Proton Drive、iCloud Drive 等桌面客户端的同步文件夹，复制进去即由客户端自动上云）。
        保存后可在阅读窗一键上传，也可全量增量同步 eml 镜像。
      </div>

      {drives.length > 0 && (
        <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] divide-y divide-ink/[0.04] mb-3">
          {drives.map(d => (
            <div key={d.id} className="px-5 py-3.5 flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl flex items-center justify-center bg-sky-100" style={{ color: 'var(--info)' }}><IconCloud width={17} height={17} /></span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-800">{d.name}</span>
                  <span className="text-2xs px-1.5 py-px rounded-sm bg-zinc-100 text-zinc-500">{DRIVE_KIND_LABEL[d.kind]}</span>
                </div>
                <div className="text-xs text-zinc-400 mt-0.5 font-mono truncate">
                  {d.kind === 'webdav'
                    ? `${d.url} → ${d.remotePath}`
                    : d.kind === 'local'
                      ? `${d.localPath ?? ''} → ${d.remotePath}`
                      : `Dropbox → ${d.remotePath}`}
                </div>
              </div>
              <button
                onClick={async () => {
                  setMsg(null)
                  const res = await api.testCloudDrive(d.id)
                  setMsg({ ok: res.ok, text: res.ok ? `${d.name} 连接正常` : `${d.name} 连接失败：${res.error ?? '未知原因'}` })
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 shrink-0"
              >
                测试
              </button>
              <button
                onClick={async () => {
                  setBusy(true)
                  const res = await api.cloudSyncEml(d.id)
                  setBusy(false)
                  setMsg({
                    ok: res.ok,
                    text: res.ok ? `${d.name} eml 同步完成：上传 ${res.uploaded ?? 0} 封，远端已有跳过 ${res.skipped ?? 0} 封` : `同步失败：${res.error ?? '未知原因'}`
                  })
                }}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 shrink-0 disabled:opacity-40"
              >
                同步 eml
              </button>
              <button
                onClick={async () => {
                  await api.removeCloudDrive(d.id)
                  await reload()
                }}
                className="text-xs text-zinc-400 hover:text-red-500 shrink-0"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] px-4 py-3">
        {!adding ? (
          <button onClick={() => setAdding(true)} className="text-xs px-3.5 py-1.5 rounded-lg bg-blue-600 text-on-accent hover:bg-blue-700">
            添加网盘
          </button>
        ) : (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {(['webdav', 'dropbox', 'local'] as CloudDriveKind[]).map(k => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`text-xs px-3 py-1.5 rounded-lg border ${kind === k ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-zinc-50 border-ink/[0.06] text-zinc-500'}`}
                >
                  {DRIVE_KIND_LABEL[k]}
                </button>
              ))}
              <span className="w-px h-4 bg-ink/10 mx-0.5" />
              <button
                onClick={() => void presetProton()}
                title="检测 Proton Drive for macOS 的同步目录并预填"
                className="text-xs px-3 py-1.5 rounded-lg border border-dashed border-ink/[0.14] text-zinc-600 hover:bg-zinc-50"
              >
                + Proton Drive
              </button>
            </div>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={kind === 'local' ? '名称（如：Proton Drive）' : '名称（如：群晖 NAS）'}
              className="w-full text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06]"
            />
            {kind === 'local' ? (
              <>
                <div className="flex items-center gap-2">
                  <input
                    value={localPath}
                    onChange={e => setLocalPath(e.target.value)}
                    placeholder="本地同步目录（如 ~/Library/CloudStorage/ProtonDrive-…-folder）"
                    className="flex-1 min-w-0 text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06] font-mono"
                  />
                  <button onClick={() => void pickLocal()} className="text-xs px-3 py-2 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 shrink-0">
                    选择…
                  </button>
                </div>
                {protonFolders && protonFolders.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {protonFolders.map(f => (
                      <button
                        key={f.path}
                        onClick={() => setLocalPath(f.path)}
                        title={f.path}
                        className={`text-2xs px-2 py-1 rounded-md border ${localPath === f.path ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-ink/[0.06] text-zinc-500'}`}
                      >
                        {f.account || 'Proton Drive'}
                      </button>
                    ))}
                  </div>
                )}
                {protonFolders && protonFolders.length === 0 && (
                  <div className="text-xs leading-relaxed rounded-lg px-3 py-2 bg-amber-50 text-amber-700">
                    未检测到 Proton Drive 同步目录。Proton Drive 没有公开 API，需先安装 Proton Drive for macOS 并登录，其同步文件夹会出现在
                    ~/Library/CloudStorage/ 下。
                    <button onClick={() => void api.openExternal(protonUrl)} className="ml-1 underline underline-offset-2">
                      下载 Proton Drive
                    </button>
                  </div>
                )}
                <div className="text-2xs text-zinc-400">
                  文件复制到「所选目录{remotePath.trim() || '/LinkTo'}/eml、/attachments」，由网盘客户端自动同步上云，无需密钥。
                </div>
              </>
            ) : kind === 'webdav' ? (
              <>
                <input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="服务器地址（如 https://nas.local:5006）"
                  className="w-full text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06] font-mono"
                />
                <input
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="用户名"
                  className="w-full text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06]"
                />
                <input
                  value={secret}
                  onChange={e => setSecret(e.target.value)}
                  type="password"
                  placeholder="密码 / 应用密码（经钥匙串加密存储）"
                  className="w-full text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06]"
                />
              </>
            ) : (
              <input
                value={secret}
                onChange={e => setSecret(e.target.value)}
                type="password"
                placeholder="Dropbox 访问令牌（App Console → Generated access token）"
                className="w-full text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06] font-mono"
              />
            )}
            <input
              value={remotePath}
              onChange={e => setRemotePath(e.target.value)}
              placeholder={kind === 'local' ? '目录内的子文件夹（如 /LinkTo）' : '远端根目录（如 /LinkTo）'}
              className="w-full text-sm bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-ink/[0.06] font-mono"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={save}
                disabled={busy}
                className="text-xs px-3.5 py-1.5 rounded-lg bg-blue-600 text-on-accent hover:bg-blue-700 disabled:opacity-40"
              >
                {busy ? '保存中…' : '保存并测试'}
              </button>
              <button
                onClick={() => {
                  setAdding(false)
                  setMsg(null)
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              >
                取消
              </button>
              {msg && <span className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>{msg.text}</span>}
            </div>
            {msg && !adding && <span className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>{msg.text}</span>}
          </div>
        )}
        {!adding && msg && (
          <div className="mt-2 text-xs">
            <span className={msg.ok ? 'text-green-600' : 'text-red-500'}>{msg.text}</span>
          </div>
        )}
      </div>
    </>
  )
}

/** 本地 MCP 服务：让 Claude Code / Claude Desktop / Cursor 等外部 Agent 读取邮件、管理待办、存草稿 */
type McpStatus = Awaited<ReturnType<typeof api.getMcpStatus>>

function McpSection(props: { onToast(t: string): void }) {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => void api.getMcpStatus().then(setStatus), [])

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    setError('')
    try {
      setStatus(await api.setMcpEnabled(enabled))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text)
    props.onToast(`已复制${label}`)
  }

  const token = status?.token ?? ''
  const url = status?.url ?? ''
  const masked = token ? `${token.slice(0, 4)}${'•'.repeat(16)}${token.slice(-4)}` : '—'
  const cliSnippet = `claude mcp add --transport http linkto ${url} --header "Authorization: Bearer ${token}"`
  const jsonSnippet = JSON.stringify({ mcpServers: { linkto: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
  const statusText = !status?.enabled
    ? '未开启'
    : status.running
      ? `运行中 · 127.0.0.1:${status.port}`
      : `未运行${status.error ? `：${status.error}` : ''}`

  return (
    <>
      <SectionTitle>MCP 服务（让外部 AI Agent 使用你的邮件）</SectionTitle>
      <div className="text-xs text-zinc-500 mb-2">
        开启后，Claude Code、Claude Desktop、Cursor 等支持 MCP 的 Agent 可以搜索和阅读邮件、查看与新建待办、检索知识库，并保存本地草稿。
      </div>
      <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] px-5 py-4">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-zinc-800">启用本地 MCP 服务</div>
            <div className={`text-xs mt-0.5 ${status?.enabled && !status.running ? 'text-red-500' : 'text-zinc-400'}`}>{statusText}</div>
          </div>
          <Toggle checked={!!status?.enabled} onChange={v => !busy && void toggle(v)} />
        </div>
        {error && <div className="text-xs text-red-500 mt-2">{error}</div>}

        {status?.enabled && (
          <div className="mt-3 pt-3 border-t border-ink/[0.04] space-y-2.5">
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500 w-12 shrink-0">地址</span>
              <span className="text-xs font-mono text-zinc-700 flex-1 truncate">{url}</span>
              <button onClick={() => copy(url, '地址')} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 shrink-0">
                复制
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500 w-12 shrink-0">Token</span>
              <span className="text-xs font-mono text-zinc-700 flex-1 truncate">{masked}</span>
              <button onClick={() => copy(token, ' Token')} disabled={!token} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 shrink-0 disabled:opacity-40">
                复制
              </button>
              <button
                onClick={async () => {
                  setStatus(await api.regenerateMcpToken())
                  props.onToast('已重新生成 Token，旧 Token 立即失效')
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 shrink-0"
              >
                重新生成
              </button>
            </div>

            <McpSnippet label="Claude Code" text={cliSnippet.replace(token, masked)} onCopy={() => copy(cliSnippet, ' Claude Code 命令')} />
            <McpSnippet label="JSON 配置（Claude Desktop / Cursor 等）" text={jsonSnippet.replace(token, masked)} onCopy={() => copy(jsonSnippet, ' JSON 配置')} />
          </div>
        )}
      </div>
      <div className="text-xs leading-relaxed text-zinc-500 bg-zinc-100/70 rounded-xl px-4 py-3 mt-2">
        仅监听本机，外部 Agent 能读取邮件内容；只能存草稿、不能发信。Token 等同于邮件访问权限，请勿外传；怀疑泄露时点「重新生成」。
      </div>
    </>
  )
}

/** 配置片段：界面展示时 token 已打码，复制得到完整内容 */
function McpSnippet(props: { label: string; text: string; onCopy(): void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-zinc-500">{props.label}</span>
        <button onClick={props.onCopy} className="text-xs px-3 py-1 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200">
          复制
        </button>
      </div>
      <pre className="text-xs bg-zinc-50 rounded-lg px-3 py-2 border border-ink/[0.06] font-mono leading-relaxed whitespace-pre-wrap break-all text-zinc-700 select-text">
        {props.text}
      </pre>
    </div>
  )
}
