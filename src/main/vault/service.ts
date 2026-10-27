import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { AppStore } from '../store'
import type { VaultAddResult, VaultItemMeta, VaultKind } from '@shared/types'
import { litmusVaultRoot, writeLitmusNote } from './litmus'

/**
 * 暂存箱 / 保险箱。
 *
 * 整个列表作为一个 safeStorage 加密字符串存进 AppStore 的密钥区
 * （macOS 上是钥匙串），不写明文 SQLite/JSON。列表接口不返回正文，
 * 保险箱正文只在 reveal/copy 时短暂进入主进程内存。
 */
interface VaultItem {
  id: string
  kind: VaultKind
  title: string
  body: string
  createdAt: number
  updatedAt: number
}

const SECRET_KEY = 'vault:items'
const MAX_BODY = 64 * 1024

export class VaultService {
  constructor(private readonly deps: { appStore: AppStore }) {}

  private load(): VaultItem[] {
    try {
      const raw = this.deps.appStore.loadSecret(SECRET_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (it): it is VaultItem =>
          !!it && typeof it === 'object' &&
          typeof (it as VaultItem).id === 'string' &&
          ((it as VaultItem).kind === 'note' || (it as VaultItem).kind === 'secret') &&
          typeof (it as VaultItem).title === 'string' &&
          typeof (it as VaultItem).body === 'string'
      )
    } catch {
      return []
    }
  }

  private save(items: VaultItem[]): void {
    this.deps.appStore.saveSecret(SECRET_KEY, JSON.stringify(items))
  }

  /** 钥匙串还在解锁时禁止写入，否则会把已有条目覆盖成新列表 */
  private locked(): boolean {
    return this.deps.appStore.secretsState() === 'pending'
  }

  list(): VaultItemMeta[] {
    return this.load()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(it => ({
        id: it.id,
        kind: it.kind,
        title: it.title,
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
        preview: it.kind === 'secret' ? '' : it.body.replace(/\s+/g, ' ').trim().slice(0, 80)
      }))
  }

  reveal(id: string): string | null {
    return this.load().find(it => it.id === id)?.body ?? null
  }

  add(kind: VaultKind, title: string, body: string): VaultAddResult {
    if (this.locked()) return { ok: false, error: '系统钥匙串还在解锁，请稍后再试' }
    const text = String(body ?? '')
    if (!text.trim()) return { ok: false, error: '内容是空的' }
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return { ok: false, error: '内容超过 64KB' }
    const now = Date.now()
    const item: VaultItem = {
      id: randomUUID(),
      kind: kind === 'secret' ? 'secret' : 'note',
      title: (String(title ?? '').trim() || (kind === 'secret' ? '未命名密码' : '未命名暂存')).slice(0, 120),
      body: text,
      createdAt: now,
      updatedAt: now
    }
    const items = this.load()
    items.push(item)
    this.save(items)
    return {
      ok: true,
      item: { id: item.id, kind: item.kind, title: item.title, createdAt: now, updatedAt: now, preview: item.kind === 'secret' ? '' : item.body.slice(0, 80) }
    }
  }

  remove(id: string): boolean {
    if (this.locked()) return false
    this.save(this.load().filter(it => it.id !== id))
    return true
  }

  litmusRoot(): string | null {
    return litmusVaultRoot(process.env.LITMUS_VAULT, app.getPath('documents'))
  }

  sendToLitmus(id: string): { ok: boolean; path?: string; error?: string } {
    const item = this.load().find(it => it.id === id)
    if (!item) return { ok: false, error: '暂存条目不存在' }
    if (item.kind === 'secret') return { ok: false, error: '保险箱里的密码不会发送到 Litmus（Litmus 是明文 Markdown）' }
    return this.sendText(item.title, item.body)
  }

  sendText(title: string, body: string): { ok: boolean; path?: string; error?: string } {
    const text = String(body ?? '')
    if (!text.trim()) return { ok: false, error: '内容是空的' }
    const root = this.litmusRoot()
    if (!root) return { ok: false, error: '没有找到 Litmus 库（默认 ~/Documents/Litmus，可用 LITMUS_VAULT 指定）' }
    try {
      return { ok: true, path: writeLitmusNote(root, String(title ?? ''), text) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
