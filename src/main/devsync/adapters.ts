/**
 * 各类别的同步适配器：把本机数据（SQLite 表 / AppStore 设置 / 密钥存储）映射成同步记录，并把远端记录落地。
 * 直接在数据层读写，不侵入各中心模块的写路径（本地变更靠快照哈希发现，见 ./protocol.ts）。
 * 同一套适配器也用于 .lkbak 备份的导出与按类恢复。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AccountConfig, AISettings, FolderPref, OAuthClientConfig, OAuthTokens } from '@shared/types'
import type { DevSyncCategory } from '@shared/devsync'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_GENERAL, DEFAULT_NOTIFICATIONS } from '../store'
import type { OAuthService } from '../oauth'
import { readFolderPrefs } from '../mail/folder-prefs'
import { notifySkillsChanged } from '../agent/hooks'
import type { ApplyContext, ApplyResult, VaultAdapter } from './engine'
import type { LocalItem } from './protocol'
import { accountKeyOf, isDeviceBoundAccount } from './refs'

/* eslint-disable @typescript-eslint/no-explicit-any */

export type AdapterCategory = DevSyncCategory | 'device'

export interface Adapter extends VaultAdapter {
  category: AdapterCategory
  /** 是否走 LinkTo-Vault（待办 / 留痕走各自的旧文件夹，只用于备份） */
  vault: boolean
}

/** 账户类适配器需要服务层配合的动作（连接测试、引擎重启、删除确认都在一轮结束后统一处理） */
export interface AccountHooks {
  created(localId: string, ctx: ApplyContext): void
  configChanged(localId: string, restart: boolean): void
  credChanged(localId: string, ctx: ApplyContext, how: 'password' | 'oauth'): void
  /** 本机专用凭据：另一台设备的密码存为候选，不启用 */
  candidateSaved(localId: string, ctx: ApplyContext): void
  requestDelete(key: string, localId: string, email: string, device: string | null): void
}

export interface AdapterDeps {
  store: MailStore
  db: DatabaseSync
  appStore: AppStore
  oauth: OAuthService
  flags(): { shareSecrets: boolean; aiKey: boolean }
  accounts: AccountHooks
  deviceId(): string
  event(payload: unknown): void
}

export const CANDIDATE_SECRET = (localId: string) => `devsync:cand:${localId}`
const DEVICES_KEY = 'devsyncDevices'
export const UI_PREFS_KEY = 'devsyncUiPrefs'

const j = <T>(s: unknown, fb: T): T => {
  if (typeof s !== 'string') return fb
  try {
    return JSON.parse(s) as T
  } catch {
    return fb
  }
}
const num = (v: unknown, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb)
const str = (v: unknown, fb = '') => (v == null ? fb : String(v))

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  appVersion: string
  lastSyncAt: number | null
}

export function readDevices(appStore: AppStore): Record<string, DeviceInfo> {
  const raw = appStore.getRaw<Record<string, DeviceInfo>>(DEVICES_KEY, {})
  return raw && typeof raw === 'object' ? raw : {}
}

export function writeDevice(appStore: AppStore, d: DeviceInfo | null, id?: string) {
  const all = readDevices(appStore)
  if (d) all[d.id] = d
  else if (id) delete all[id]
  appStore.set(DEVICES_KEY, all)
}

/** 通用：AppStore 里的一个设置对象 */
function settingAdapter(o: {
  type: string
  category: AdapterCategory
  read(): unknown | null
  write(data: any): void
  mtime?(): number | undefined
}): Adapter {
  return {
    type: o.type,
    category: o.category,
    vault: true,
    list() {
      const d = o.read()
      return d == null ? [] : [{ id: 'v', data: d, mtime: o.mtime?.() }]
    },
    apply(_id, data) {
      if (data && typeof data === 'object') o.write(data)
    },
    // 设置不会被「删除」：远端墓碑忽略
    remove() {},
    noLocalTombstones: true
  }
}

export function buildAdapters(deps: AdapterDeps): Adapter[] {
  const { store, db, appStore, oauth } = deps
  const out: Adapter[] = []
  const accounts = () => store.listAccounts()
  const byKey = (key: string) => accounts().find(a => accountKeyOf(a) === key) ?? null

  // ================= 账户与凭据 =================

  out.push(
    settingAdapter({
      type: 'oauth-clients',
      category: 'accounts',
      read: () => {
        const c = appStore.getRaw<OAuthClientConfig | null>('oauthClients', null)
        return c && (c.google?.clientId || c.ms?.clientId) ? c : null
      },
      write: d => appStore.set('oauthClients', d)
    })
  )
  out[out.length - 1].priority = 0

  const folderPrefsOf = (accountId: string): Record<string, FolderPref> => {
    const prefix = `${accountId}::`
    const res: Record<string, FolderPref> = {}
    for (const [id, p] of Object.entries(readFolderPrefs(appStore))) if (id.startsWith(prefix)) res[id.slice(prefix.length)] = p
    return res
  }
  const writeFolderPrefs = (accountId: string, prefs: Record<string, FolderPref> | undefined) => {
    if (!prefs || typeof prefs !== 'object') return
    const prefix = `${accountId}::`
    const all = readFolderPrefs(appStore)
    for (const k of Object.keys(all)) if (k.startsWith(prefix)) delete all[k]
    for (const [path, p] of Object.entries(prefs)) {
      if (!p || typeof p !== 'object') continue
      const pref = { pinned: !!p.pinned, sync: p.sync !== false }
      if (pref.pinned || !pref.sync) all[prefix + path] = pref
    }
    appStore.set('folderPrefs', all)
  }

  const accountData = (a: AccountConfig) => ({
    provider: a.provider,
    name: a.name,
    email: a.email,
    color: a.color,
    enabled: a.enabled,
    signatureId: a.signatureId ?? null,
    imap: a.imap,
    smtp: a.smtp,
    user: a.user,
    authType: a.authType ?? 'password',
    createdAt: a.createdAt,
    deviceBound: isDeviceBoundAccount(a),
    folderPrefs: folderPrefsOf(a.id)
  })

  out.push({
    type: 'account',
    category: 'accounts',
    vault: true,
    priority: 10,
    list: () => accounts().map(a => ({ id: accountKeyOf(a), data: accountData(a) })),
    apply(key, raw, ctx) {
      const d = raw as ReturnType<typeof accountData>
      if (!d?.email || !d.imap?.host) return
      const local = byKey(key)
      if (!local) {
        const id = randomUUID()
        const next: AccountConfig = {
          id,
          provider: d.provider,
          name: str(d.name, d.email),
          email: d.email,
          color: str(d.color, '#3b82f6'),
          enabled: d.enabled !== false,
          signatureId: d.signatureId ?? null,
          imap: { host: str(d.imap.host), port: num(d.imap.port, 993), secure: !!d.imap.secure },
          smtp: { host: str(d.smtp?.host), port: num(d.smtp?.port, 465), secure: !!d.smtp?.secure },
          user: str(d.user, d.email),
          authType: d.authType === 'oauth' ? 'oauth' : 'password',
          createdAt: num(d.createdAt, Date.now())
        }
        store.upsertAccount(next)
        writeFolderPrefs(id, d.folderPrefs)
        deps.accounts.created(id, ctx)
        return
      }
      const bound = isDeviceBoundAccount(local) || !!d.deviceBound
      // 设备相关账户：服务器 / 端口按本机为准（每台电脑的 Bridge 端口可能不同）
      const imap = bound ? local.imap : { host: str(d.imap.host), port: num(d.imap.port, 993), secure: !!d.imap.secure }
      const smtp = bound ? local.smtp : { host: str(d.smtp?.host), port: num(d.smtp?.port, 465), secure: !!d.smtp?.secure }
      const next: AccountConfig = {
        ...local,
        name: str(d.name, local.name),
        color: str(d.color, local.color),
        enabled: d.enabled !== false,
        signatureId: d.signatureId ?? null,
        imap,
        smtp,
        user: bound ? local.user : str(d.user, local.user),
        authType: d.authType === 'oauth' ? 'oauth' : 'password'
      }
      const restart =
        JSON.stringify([local.imap, local.smtp, local.user, local.authType]) !== JSON.stringify([next.imap, next.smtp, next.user, next.authType]) ||
        local.enabled !== next.enabled
      store.upsertAccount(next)
      writeFolderPrefs(local.id, d.folderPrefs)
      deps.accounts.configChanged(local.id, restart)
    },
    remove(key, ctx) {
      const local = byKey(key)
      if (!local) return
      // 不静默删除账户：登记待确认，本机保持原样
      deps.accounts.requestDelete(key, local.id, local.email, ctx.device)
      return 'defer'
    }
  })

  out.push({
    type: 'cred',
    category: 'accounts',
    vault: true,
    priority: 20,
    noLocalTombstones: true,
    list() {
      const items: LocalItem[] = []
      for (const a of accounts()) {
        const deviceBound = isDeviceBoundAccount(a)
        if (a.authType === 'oauth') {
          const t = oauth.loadTokens(a.id)
          if (!t?.refreshToken && !t?.accessToken) continue
          items.push({
            id: accountKeyOf(a),
            data: { kind: 'oauth', tokens: { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, email: t.email }, deviceBound },
            // access token 每小时刷新：只有 refresh token 变了才算改动
            sig: { kind: 'oauth', refreshToken: t.refreshToken ?? t.accessToken, deviceBound }
          })
        } else {
          const secret = appStore.loadSecret(`acct:${a.id}`)
          if (!secret) continue
          items.push({ id: accountKeyOf(a), data: { kind: 'password', secret, deviceBound } })
        }
      }
      return items
    },
    apply(key, raw, ctx) {
      const d = raw as { kind: string; secret?: string; tokens?: OAuthTokens; deviceBound?: boolean }
      const local = byKey(key)
      if (!local || !d) return
      if (d.deviceBound || isDeviceBoundAccount(local)) {
        // 本机专用：存为候选（同样加密保存在本机钥匙串），不当成可用凭据
        appStore.saveSecret(CANDIDATE_SECRET(local.id), JSON.stringify({ kind: d.kind, secret: d.secret, tokens: d.tokens, device: ctx.device, at: ctx.updatedAt }))
        deps.accounts.candidateSaved(local.id, ctx)
        return
      }
      if (d.kind === 'oauth' && d.tokens) {
        const cur = oauth.loadTokens(local.id)
        if (cur?.refreshToken === d.tokens.refreshToken && cur?.accessToken) return
        oauth.saveTokens(local.id, {
          accessToken: d.tokens.accessToken || 'pending-refresh',
          refreshToken: d.tokens.refreshToken,
          expiresAt: d.tokens.accessToken ? num(d.tokens.expiresAt) : 0,
          email: d.tokens.email
        })
        deps.accounts.credChanged(local.id, ctx, 'oauth')
        return
      }
      if (d.kind === 'password' && d.secret) {
        if (appStore.loadSecret(`acct:${local.id}`) === d.secret) return
        appStore.saveSecret(`acct:${local.id}`, d.secret)
        deps.accounts.credChanged(local.id, ctx, 'password')
      }
    },
    // 凭据不随墓碑删除（账户删除另有确认流程）
    remove() {}
  })

  // ================= Agent 记忆 =================

  const memKey = (r: any) => `${r.scope}\u0001${r.entity ?? ''}\u0001${r.title}`
  out.push({
    type: 'memory',
    category: 'memory',
    vault: true,
    list: () =>
      (db.prepare('SELECT * FROM agent_memory').all() as any[]).map(r => ({
        id: memKey(r),
        mtime: num(r.updated_at) || undefined,
        data: {
          scope: r.scope,
          entity: r.entity ?? '',
          title: r.title,
          content: r.content ?? '',
          source: r.source ?? 'auto',
          sourceMessageId: r.source_message_id ?? null,
          confidence: num(r.confidence, 0.8),
          status: r.status ?? 'active',
          createdAt: num(r.created_at)
        }
      })),
    apply(_id, raw, ctx) {
      const d = raw as any
      if (!d?.scope || !d.title) return
      const ex = db.prepare('SELECT id FROM agent_memory WHERE scope = ? AND entity = ? AND title = ?').get(d.scope, d.entity ?? '', d.title) as any
      if (ex)
        db.prepare('UPDATE agent_memory SET content = ?, source = ?, source_message_id = ?, confidence = ?, status = ?, updated_at = ? WHERE id = ?').run(
          str(d.content), str(d.source, 'auto'), d.sourceMessageId ?? null, num(d.confidence, 0.8), str(d.status, 'active'), ctx.updatedAt, ex.id
        )
      else
        db.prepare(
          `INSERT INTO agent_memory (id, scope, entity, title, content, source, source_message_id, confidence, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(`mem-${randomUUID()}`, d.scope, d.entity ?? '', d.title, str(d.content), str(d.source, 'auto'), d.sourceMessageId ?? null, num(d.confidence, 0.8), str(d.status, 'active'), num(d.createdAt, ctx.updatedAt), ctx.updatedAt)
    },
    remove(id) {
      const [scope, entity, title] = id.split('\u0001')
      db.prepare('DELETE FROM agent_memory WHERE scope = ? AND entity = ? AND title = ?').run(scope, entity ?? '', title ?? '')
    }
  })

  // ================= 知识库 =================

  out.push({
    type: 'kb',
    category: 'kb',
    vault: true,
    list: () =>
      (db.prepare('SELECT * FROM kb_items').all() as any[]).map(r => ({
        id: r.id,
        data: { kind: r.kind, title: r.title, content: r.content ?? '', sourceMessageId: r.source_message_id ?? null, sourceLabel: r.source_label ?? null, tags: j<string[]>(r.tags, []), createdAt: num(r.created_at) }
      })),
    apply(id, raw) {
      const d = raw as any
      if (!d?.title) return
      db.prepare(
        `INSERT INTO kb_items (id, kind, title, content, source_message_id, source_label, tags, created_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, content=excluded.content, source_message_id=excluded.source_message_id,
           source_label=excluded.source_label, tags=excluded.tags`
      ).run(id, str(d.kind, 'note'), d.title, str(d.content), d.sourceMessageId ?? null, d.sourceLabel ?? null, JSON.stringify(Array.isArray(d.tags) ? d.tags : []), num(d.createdAt, Date.now()))
    },
    remove(id) {
      db.prepare('DELETE FROM kb_items WHERE id = ?').run(id)
    }
  })

  // ================= 技能 =================

  const SKILLS_KEY = 'agentSkills'
  const skillData = () => {
    const raw = appStore.getRaw<any>(SKILLS_KEY, {})
    return { custom: Array.isArray(raw?.custom) ? raw.custom : [], overrides: raw?.overrides && typeof raw.overrides === 'object' ? raw.overrides : {} } as { custom: any[]; overrides: Record<string, any> }
  }
  const saveSkills = (d: { custom: any[]; overrides: Record<string, any> }) => {
    appStore.set(SKILLS_KEY, d)
    notifySkillsChanged()
    deps.event({ type: 'agent-skills-changed' })
  }
  out.push({
    type: 'skill',
    category: 'skills',
    vault: true,
    list: () => skillData().custom.filter(s => s && typeof s.id === 'string').map(s => ({ id: s.id, data: s, mtime: num(s.updatedAt) || undefined })),
    apply(id, raw) {
      if (!raw || typeof raw !== 'object') return
      const d = skillData()
      const s = { ...(raw as object), id, builtin: false }
      const i = d.custom.findIndex(x => x.id === id)
      if (i >= 0) d.custom[i] = s
      else d.custom.push(s)
      saveSkills(d)
    },
    remove(id) {
      const d = skillData()
      d.custom = d.custom.filter(x => x.id !== id)
      saveSkills(d)
    }
  })
  out.push({
    type: 'skill-override',
    category: 'skills',
    vault: true,
    list: () => Object.entries(skillData().overrides).map(([id, o]) => ({ id, data: o })),
    apply(id, raw) {
      if (!raw || typeof raw !== 'object') return
      const d = skillData()
      d.overrides[id] = raw
      saveSkills(d)
    },
    remove(id) {
      const d = skillData()
      delete d.overrides[id]
      saveSkills(d)
    }
  })

  // ================= Agent 对话 =================

  const hasThreads = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_threads'").get()
  out.push({
    type: 'thread',
    category: 'threads',
    vault: true,
    list: () =>
      hasThreads()
        ? (db.prepare('SELECT * FROM agent_threads').all() as any[]).map(r => ({
            id: r.id,
            mtime: num(r.updated_at) || undefined,
            data: { title: r.title, skillId: r.skill_id ?? null, createdAt: num(r.created_at), updatedAt: num(r.updated_at), turns: num(r.turns), messages: j<unknown[]>(r.data, []) }
          }))
        : [],
    apply(id, raw) {
      const d = raw as any
      if (!d || !hasThreads()) return
      const messages = Array.isArray(d.messages) ? d.messages : []
      db.prepare(
        `INSERT INTO agent_threads (id, title, skill_id, created_at, updated_at, turns, data) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, skill_id=excluded.skill_id, updated_at=excluded.updated_at, turns=excluded.turns, data=excluded.data`
      ).run(id, str(d.title, '对话'), d.skillId ?? null, num(d.createdAt, Date.now()), num(d.updatedAt, Date.now()), messages.length, JSON.stringify(messages))
      deps.event({ type: 'agent-threads-changed' })
    },
    remove(id) {
      if (hasThreads()) db.prepare('DELETE FROM agent_threads WHERE id = ?').run(id)
      deps.event({ type: 'agent-threads-changed' })
    }
  })

  // ================= 各中心（insights 表） =================

  const insightAdapter = (kind: string, category: DevSyncCategory, vault: boolean): Adapter => ({
    type: `ins.${kind}`,
    category,
    vault,
    list: () =>
      (db.prepare('SELECT * FROM insights WHERE kind = ?').all(kind) as any[]).map(r => {
        const inner = j<Record<string, unknown>>(r.data_json, {})
        const { _xref, ...rest } = inner as { _xref?: unknown }
        return {
          id: r.id,
          mtime: num(inner.updatedAt) || num(r.created_at) || undefined,
          data: {
            title: r.title,
            status: r.status ?? 'open',
            dueAt: r.due_at ?? null,
            period: r.period ?? null,
            createdAt: num(r.created_at),
            accountId: r.account_id ?? null,
            messageId: r.message_id ?? null,
            data: rest,
            ...(_xref ? { _xref } : {})
          }
        }
      }),
    apply(id, raw, ctx) {
      const d = raw as any
      if (!d || typeof d.title !== 'string') return
      const inner: Record<string, unknown> = { ...(d.data && typeof d.data === 'object' ? d.data : {}), updatedAt: ctx.updatedAt }
      if (d._xref) inner._xref = d._xref
      const accountId = d.accountId && store.listAccounts().some(a => a.id === d.accountId) ? d.accountId : null
      const messageId = d.messageId && store.getMessageRow(d.messageId) ? d.messageId : null
      db.prepare(
        `INSERT INTO insights (id, kind, account_id, message_id, title, data_json, status, due_at, period, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, message_id=excluded.message_id, title=excluded.title, data_json=excluded.data_json,
           status=excluded.status, due_at=excluded.due_at, period=excluded.period`
      ).run(id, kind, accountId, messageId, d.title, JSON.stringify(inner), str(d.status, 'open'), d.dueAt ?? null, d.period ?? null, num(d.createdAt, ctx.updatedAt))
    },
    remove(id) {
      db.prepare('DELETE FROM insights WHERE id = ? AND kind = ?').run(id, kind)
    }
  })
  out.push(insightAdapter('finance', 'finance', true))
  out.push(insightAdapter('project', 'project', true))
  out.push(insightAdapter('life', 'life', true))
  out.push(insightAdapter('followup', 'followup', true))
  out.push(insightAdapter('reading', 'reading', true))
  // 待办 / 留痕：同步走各自的旧文件夹，这里只用于备份与恢复
  out.push(insightAdapter('todo', 'todo', false))
  out.push(insightAdapter('trace', 'trace', false))

  // ================= 订阅源与 AI 搜索主题 =================

  const hasFeeds = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feed_sources'").get()
  const feedKey = (r: any) => (r.kind === 'feed' && r.url ? `u:${String(r.url).trim().toLowerCase()}` : `s:${r.id}`)
  out.push({
    type: 'feed-source',
    category: 'feeds',
    vault: true,
    list: () =>
      hasFeeds()
        ? (db.prepare('SELECT * FROM feed_sources').all() as any[]).map(r => ({
            id: feedKey(r),
            data: {
              rowId: r.id,
              kind: r.kind,
              title: r.title,
              url: r.url ?? null,
              siteUrl: r.site_url ?? null,
              group: r.group_name ?? null,
              format: r.format ?? null,
              intervalMin: r.interval_min ?? null,
              fullText: !!r.full_text,
              enabled: !!r.enabled,
              topic: j<unknown>(r.topic_json, null),
              sort: num(r.sort),
              createdAt: num(r.created_at)
            }
          }))
        : [],
    apply(key, raw) {
      const d = raw as any
      if (!d || !hasFeeds()) return
      const ex = key.startsWith('u:')
        ? (db.prepare("SELECT id FROM feed_sources WHERE kind = 'feed' AND lower(trim(url)) = ?").get(key.slice(2)) as any)
        : (db.prepare('SELECT id FROM feed_sources WHERE id = ?').get(key.slice(2)) as any)
      const vals = [str(d.kind, 'feed'), str(d.title, '订阅').slice(0, 200), d.url ?? null, d.siteUrl ?? null, d.group ?? null, d.format ?? null, d.intervalMin ?? null, d.fullText ? 1 : 0, d.enabled === false ? 0 : 1, d.topic ? JSON.stringify(d.topic) : null, num(d.sort)]
      if (ex)
        db.prepare(
          'UPDATE feed_sources SET kind=?, title=?, url=?, site_url=?, group_name=?, format=?, interval_min=?, full_text=?, enabled=?, topic_json=?, sort=? WHERE id = ?'
        ).run(...vals, ex.id)
      else {
        const wanted = key.startsWith('s:') ? key.slice(2) : str(d.rowId)
        const id = wanted && !db.prepare('SELECT 1 FROM feed_sources WHERE id = ?').get(wanted) ? wanted : `feed-${randomUUID()}`
        db.prepare(
          `INSERT INTO feed_sources (id, kind, title, url, site_url, group_name, format, interval_min, full_text, enabled, topic_json, sort, created_at, next_fetch_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`
        ).run(id, ...vals, num(d.createdAt, Date.now()))
      }
      deps.event({ type: 'feeds-changed', sourceId: null })
    },
    remove(key) {
      if (!hasFeeds()) return
      const ex = key.startsWith('u:')
        ? (db.prepare("SELECT id FROM feed_sources WHERE kind = 'feed' AND lower(trim(url)) = ?").get(key.slice(2)) as any)
        : (db.prepare('SELECT id FROM feed_sources WHERE id = ?').get(key.slice(2)) as any)
      if (!ex) return
      for (const t of ['feed_items', 'feed_gone', 'feed_seen']) db.prepare(`DELETE FROM ${t} WHERE source_id = ?`).run(ex.id)
      db.prepare('DELETE FROM feed_sources WHERE id = ?').run(ex.id)
      deps.event({ type: 'feeds-changed', sourceId: null })
    }
  })
  out.push(
    settingAdapter({
      type: 'setting.feedSettings',
      category: 'feeds',
      read: () => appStore.getRaw<object | null>('feedSettings', null),
      write: d => appStore.set('feedSettings', d)
    })
  )

  // ================= 规则 / 模板 / 签名 =================

  out.push({
    type: 'rule',
    category: 'rules',
    vault: true,
    list: () => store.listRules().map(r => ({ id: r.id, data: r })),
    apply(id, raw) {
      const r = raw as any
      if (!r || typeof r.name !== 'string') return
      store.saveRule({ ...r, id, conditions: Array.isArray(r.conditions) ? r.conditions : [], actions: Array.isArray(r.actions) ? r.actions : [], order: num(r.order) })
    },
    remove(id) {
      store.deleteRule(id)
    }
  })
  out.push({
    type: 'template',
    category: 'templates',
    vault: true,
    list: () => store.listTemplates().map(t => ({ id: t.id, data: t, mtime: num(t.updatedAt) || undefined })),
    apply(id, raw, ctx) {
      const t = raw as any
      if (!t || typeof t.name !== 'string') return
      store.saveTemplate({ ...t, id, to: str(t.to), subject: str(t.subject), html: str(t.html), updatedAt: num(t.updatedAt, ctx.updatedAt) })
    },
    remove(id) {
      store.deleteTemplate(id)
    }
  })
  out.push({
    type: 'signature',
    category: 'signatures',
    vault: true,
    priority: 15,
    list: () => store.listSignatures().map(s => ({ id: s.id, data: s, mtime: num(s.updatedAt) || undefined })),
    apply(id, raw, ctx) {
      const s = raw as any
      if (!s || typeof s.name !== 'string') return
      const known = new Set(store.listAccounts().map(a => a.id))
      store.saveSignature({ ...s, id, html: str(s.html), defaults: (Array.isArray(s.defaults) ? s.defaults : []).filter((x: string) => known.has(x)), updatedAt: num(s.updatedAt, ctx.updatedAt) })
    },
    remove(id) {
      store.deleteSignature(id)
    }
  })

  // ================= 个性化 =================

  out.push(
    settingAdapter({
      type: 'setting.general',
      category: 'prefs',
      read: () => {
        const g = appStore.get('general', DEFAULT_GENERAL) as unknown as Record<string, unknown>
        // 开机自启是每台电脑自己的事，不同步
        const { launchAtLogin: _l, ...rest } = g
        return rest
      },
      write: d => {
        const cur = appStore.get('general', DEFAULT_GENERAL)
        appStore.set('general', { ...cur, ...d, launchAtLogin: cur.launchAtLogin })
      }
    }),
    settingAdapter({
      type: 'setting.notifications',
      category: 'prefs',
      read: () => appStore.get('notifications', DEFAULT_NOTIFICATIONS),
      write: d => appStore.set('notifications', { ...appStore.get('notifications', DEFAULT_NOTIFICATIONS), ...d })
    }),
    settingAdapter({
      type: 'ui-prefs',
      category: 'prefs',
      read: () => appStore.getRaw<{ data?: unknown } | null>(UI_PREFS_KEY, null)?.data ?? null,
      write: d => {
        appStore.set(UI_PREFS_KEY, { data: d, at: Date.now() })
        // 设置窗 / 主窗口收到后写进各自的 localStorage
        deps.event({ type: 'devsync-ui-prefs', data: d })
      }
    })
  )
  out.push({
    type: 'smart-view',
    category: 'prefs',
    vault: true,
    list: () => (db.prepare('SELECT * FROM smart_views').all() as any[]).map(r => ({ id: r.id, data: { name: r.name, view: j<unknown>(r.view_json, {}), createdAt: num(r.created_at) } })),
    apply(id, raw) {
      const d = raw as any
      if (!d?.name) return
      db.prepare('INSERT INTO smart_views (id, name, view_json, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, view_json=excluded.view_json').run(
        id, d.name, JSON.stringify(d.view ?? {}), num(d.createdAt, Date.now())
      )
    },
    remove(id) {
      db.prepare('DELETE FROM smart_views WHERE id = ?').run(id)
    }
  })

  // ================= 分享目标 =================

  const targets = () => {
    const l = appStore.getRaw<any[]>('share-targets', [])
    return Array.isArray(l) ? l : []
  }
  out.push({
    type: 'share-target',
    category: 'share',
    vault: true,
    list: () =>
      targets()
        .filter(t => t && typeof t.id === 'string')
        .map(t => {
          const sec = deps.flags().shareSecrets ? appStore.loadSecret(`share:${t.id}`) : ''
          return { id: t.id, data: { target: t, ...(sec ? { secrets: j<object>(sec, {}) } : {}) } }
        }),
    apply(id, raw) {
      const d = raw as { target?: any; secrets?: object }
      if (!d?.target) return
      const list = targets()
      const i = list.findIndex(t => t.id === id)
      const next = { ...d.target, id }
      if (i >= 0) list[i] = next
      else list.push(next)
      appStore.set('share-targets', list)
      if (d.secrets && deps.flags().shareSecrets) appStore.saveSecret(`share:${id}`, JSON.stringify(d.secrets))
      deps.event({ type: 'share-targets-changed' })
    },
    remove(id) {
      appStore.set('share-targets', targets().filter(t => t.id !== id))
      appStore.deleteSecret(`share:${id}`)
      deps.event({ type: 'share-targets-changed' })
    }
  })
  out.push(
    settingAdapter({
      type: 'setting.share-settings',
      category: 'share',
      read: () => appStore.getRaw<object | null>('share-settings', null),
      write: d => appStore.set('share-settings', d)
    })
  )

  // ================= AI 设置 =================

  out.push(
    settingAdapter({
      type: 'setting.ai',
      category: 'ai',
      read: () => {
        const ai = appStore.getAI()
        const { apiKey, ...rest } = ai
        return deps.flags().aiKey && apiKey ? { ...rest, apiKey } : rest
      },
      write: d => {
        const cur = appStore.getAI()
        const incoming = d as Partial<AISettings>
        appStore.setAI({ ...cur, ...incoming, apiKey: deps.flags().aiKey && typeof incoming.apiKey === 'string' && incoming.apiKey ? incoming.apiKey : cur.apiKey })
      }
    })
  )
  const SEARCH_PROVIDERS = ['brave', 'tavily', 'serpapi']
  const feedKeySecret = (p: string) => `feed:search:${p}`
  out.push(
    settingAdapter({
      type: 'secret.feed-search',
      category: 'ai',
      read: () => {
        if (!deps.flags().aiKey) return null
        const keys: Record<string, string> = {}
        for (const p of SEARCH_PROVIDERS) {
          const k = appStore.loadSecret(feedKeySecret(p))
          if (k) keys[p] = k
        }
        return Object.keys(keys).length ? keys : null
      },
      write: d => {
        if (!deps.flags().aiKey) return
        for (const [p, k] of Object.entries(d as Record<string, string>)) if (SEARCH_PROVIDERS.includes(p) && typeof k === 'string' && k) appStore.saveSecret(feedKeySecret(p), k)
      }
    })
  )

  // ================= 自动任务 / 附件内容授权 =================

  out.push(
    settingAdapter({
      type: 'setting.agentJobSettings',
      category: 'jobs',
      read: () => appStore.getRaw<object | null>('agentJobSettings', null),
      write: d => appStore.set('agentJobSettings', d)
    }),
    settingAdapter({
      type: 'job-enabled',
      category: 'jobs',
      read: () => {
        const st = appStore.getRaw<Record<string, { enabled?: boolean }>>('agentJobs', {}) ?? {}
        const flags: Record<string, boolean> = {}
        for (const [id, s] of Object.entries(st)) if (typeof s?.enabled === 'boolean') flags[id] = s.enabled
        return Object.keys(flags).length ? flags : null
      },
      write: d => {
        const st = appStore.getRaw<Record<string, any>>('agentJobs', {}) ?? {}
        for (const [id, v] of Object.entries(d as Record<string, unknown>)) if (typeof v === 'boolean') st[id] = { lastRunAt: null, lastResult: null, lastError: null, retryAfter: null, failures: 0, ...(st[id] ?? {}), enabled: v }
        appStore.set('agentJobs', st)
        deps.event({ type: 'agent-jobs' })
      }
    }),
    settingAdapter({
      type: 'setting.attachmentAccess',
      category: 'attachAccess',
      read: () => appStore.getRaw<object | null>('attachmentAccess', null),
      write: d => {
        appStore.set('attachmentAccess', d)
        deps.event({ type: 'content-access-changed', settings: d })
      },
      mtime: () => num(appStore.getRaw<any>('attachmentAccess', null)?.updatedAt) || undefined
    })
  )

  // ================= 设备（始终同步：设置页「已知设备」） =================

  out.push({
    type: 'device',
    category: 'device',
    vault: true,
    priority: 1,
    noLocalTombstones: true,
    list: () => Object.values(readDevices(appStore)).map(d => ({ id: d.id, data: d, mtime: d.lastSyncAt ?? undefined })),
    apply(id, raw) {
      if (id === deps.deviceId()) return
      const d = raw as DeviceInfo
      if (d && typeof d.name === 'string') writeDevice(appStore, { ...d, id })
    },
    remove(id) {
      if (id !== deps.deviceId()) writeDevice(appStore, null, id)
    }
  })

  return out
}
