import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComposeDraft, GhostSendDraft, AccountConfig } from '@shared/types'
import type { AppStore } from '../store'
import type { MailStore } from '../db'
import type { MailSender, MailCreds } from '../mail/sender'
import {
  createIdentity,
  fingerprintOf,
  isAddressedTo,
  openEnvelope,
  parseEnvelope,
  sealEnvelope,
  type GhostEnvelope
} from './envelope'
import { relayPoll, relaySend } from './relay'

export type { GhostItem } from '@shared/types'
import type { GhostItem } from '@shared/types'

interface GhostManifestEntry {
  id: string
  file: string
  receivedAt: number
  sealedBytes: number
}

interface GhostManifest {
  items: GhostManifestEntry[]
}

const EXT = '.lkghost'

/**
 * 幽灵信服务：端到端加密 · 阅后即焚 · 不基于邮箱账号身份
 *
 *  - 幽灵身份：本机 X25519 密钥对，私钥经 safeStorage 入钥匙串，对外只有公钥（幽灵 ID）
 *  - 信箱：dataDir/ghost/ 下的 .lkghost 密文 blob + index.json 清单
 *  - 严格焚毁：成功开信 = 立即删除密文 blob（明文仅驻内存）→ 二次打开永久失败
 *  - 收取：扫描全部邮件账户的 .lkghost 附件 → 落信箱 → 永久删除原始邮件（服务器+本地，
 *    含已发送文件夹里的信封副本），服务商侧不留信道痕迹
 */
export class GhostService {
  /** 由宿主注入：永久删除邮件（服务器 + 本地），用于焚毁信道 */
  deleteMails?: (ids: string[]) => Promise<void>

  private readonly ghostDir: string
  private readonly manifestPath: string

  constructor(
    private deps: {
      appStore: AppStore
      store: MailStore
      sender: MailSender
      getCreds: (account: AccountConfig) => Promise<MailCreds>
      event: (payload: unknown) => void
    }
  ) {
    this.ghostDir = join(deps.appStore.dataDir, 'ghost')
    this.manifestPath = join(this.ghostDir, 'index.json')
    mkdirSync(this.ghostDir, { recursive: true })
  }

  // ---------- 幽灵身份 ----------

  identity(): { ghostId: string; fingerprint: string } {
    const raw = this.deps.appStore.loadSecret('ghost:identity')
    if (raw) {
      try {
        const id = JSON.parse(raw) as { spki: string; pkcs8: string }
        return { ghostId: id.spki, fingerprint: fingerprintOf(id.spki) }
      } catch { /* 损坏则重建 */ }
    }
    const id = createIdentity()
    this.deps.appStore.saveSecret('ghost:identity', JSON.stringify(id))
    return { ghostId: id.spki, fingerprint: fingerprintOf(id.spki) }
  }

  private privKeyB64(): string {
    const raw = this.deps.appStore.loadSecret('ghost:identity')
    if (!raw) throw new Error('幽灵身份未初始化')
    return (JSON.parse(raw) as { pkcs8: string }).pkcs8
  }

  // ---------- 信箱 ----------

  private readManifest(): GhostManifest {
    try {
      return JSON.parse(readFileSync(this.manifestPath, 'utf8')) as GhostManifest
    } catch {
      return { items: [] }
    }
  }

  private writeManifest(m: GhostManifest) {
    writeFileSync(this.manifestPath, JSON.stringify(m))
  }

  list(): GhostItem[] {
    return this.readManifest()
      .items
      .map(({ id, receivedAt, sealedBytes }) => ({ id, receivedAt, sealedBytes }))
      .sort((a, b) => b.receivedAt - a.receivedAt)
  }

  /** 拒收（未读焚毁）：直接销毁密文 blob */
  burn(id: string): { ok: boolean; error?: string } {
    const m = this.readManifest()
    const entry = m.items.find(i => i.id === id)
    if (!entry) return { ok: false, error: '信不存在或已焚毁' }
    rmSync(join(this.ghostDir, entry.file), { force: true })
    this.writeManifest({ items: m.items.filter(i => i.id !== id) })
    this.deps.event({ type: 'ghost-changed' })
    return { ok: true }
  }

  /** 双因子开信（私钥 + 口令）→ 成功即焚毁信封，明文仅驻内存返回给焚毁阅读窗 */
  openItem(id: string, password: string): { ok: boolean; error?: string; body?: string } {
    const m = this.readManifest()
    const entry = m.items.find(i => i.id === id)
    if (!entry) return { ok: false, error: '信不存在或已焚毁' }
    const file = join(this.ghostDir, entry.file)
    let env: GhostEnvelope
    try {
      env = parseEnvelope(readFileSync(file))
    } catch (err) {
      return { ok: false, error: `信封读取失败：${err instanceof Error ? err.message : String(err)}` }
    }
    try {
      const body = openEnvelope(env, password, this.privKeyB64())
      // 严格焚毁：开信成功即刻销毁密文，物理上杜绝二次打开
      rmSync(file, { force: true })
      this.writeManifest({ items: m.items.filter(i => i.id !== id) })
      this.deps.event({ type: 'ghost-changed' })
      return { ok: true, body }
    } catch (err) {
      // 口令错误：信封保留，可重试
      return { ok: false, error: err instanceof Error ? err.message : '口令错误' }
    }
  }

  // ---------- 发送 ----------

  /** 中继地址配置（settings 表：ghost.relayUrl） */
  relayUrl(): string {
    return this.deps.appStore.get<string>('ghost.relayUrl', '')
  }

  setRelayUrl(url: string): void {
    this.deps.appStore.set('ghost.relayUrl', url.trim().replace(/\/+$/, ''))
  }

  /**
   * 封装并投递。via='mail'：以 .lkghost 附件经指定账户投递（主题/正文全空，不泄露内容）；
   * via='relay'：密文直投匿名中继（伪装 HTTPS 笔记同步 API），无需任何邮箱账户，无需收件人邮箱。
   */
  async send(draft: GhostSendDraft): Promise<{ ok: boolean; error?: string }> {
    if (!draft.text.trim()) return { ok: false, error: '正文为空' }
    if (!draft.ghostId.trim()) return { ok: false, error: '缺少收件人幽灵 ID' }
    if (!draft.password) return { ok: false, error: '需要设置打开口令' }
    let envelopeJson: string
    try {
      envelopeJson = sealEnvelope(draft.text, draft.password, draft.ghostId.trim(), draft.via === 'relay' ? 'relay' : 'mail')
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (draft.via === 'relay') {
      const relay = this.relayUrl()
      if (!relay) return { ok: false, error: '未配置中继地址（幽灵信箱 → 设置）' }
      try {
        await relaySend(relay, draft.ghostId.trim(), envelopeJson)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const account = this.deps.store.listAccounts().find(a => a.id === draft.accountId)
    if (!account) return { ok: false, error: '未找到投递账户' }
    const tmp = join(this.ghostDir, `outbox-${Date.now()}${EXT}`)
    writeFileSync(tmp, envelopeJson)
    const mailDraft: ComposeDraft = {
      id: randomUUID(),
      accountId: account.id,
      to: [{ address: draft.to.trim() }],
      cc: [],
      bcc: [],
      subject: '',
      html: '<p></p>',
      attachmentPaths: [tmp]
    }
    try {
      const creds = await this.deps.getCreds(account)
      await this.deps.sender.send(account, creds, mailDraft)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  // ---------- 收取 ----------

  /**
   * 扫描所有账户邮件中的 .lkghost 附件：
   *  - 发往本机幽灵身份 → 落入信箱，原邮件永久删除（服务器+本地）
   *  - 非发往本机（如自己发出的信封回声）→ 仅焚毁信道，不落信箱
   *  - 附件尚未下载到本地 → 跳过待下轮
   */
  async receiveScan(): Promise<{ imported: number; burned: number; pending: number; error?: string }> {
    let imported = 0
    let burned = 0
    let pending = 0
    const atts = this.deps.store.listGhostAttachments()
    const toDelete: string[] = []
    for (const att of atts) {
      if (!att.path || !existsSync(att.path)) {
        pending++
        continue
      }
      let env: GhostEnvelope
      try {
        env = parseEnvelope(readFileSync(att.path))
      } catch {
        pending++
        continue
      }
      if (isAddressedTo(env, this.privKeyB64())) {
        const id = randomUUID()
        const file = `${id}${EXT}`
        writeFileSync(join(this.ghostDir, file), readFileSync(att.path))
        const m = this.readManifest()
        m.items.push({ id, file, receivedAt: Date.now(), sealedBytes: att.size ?? 0 })
        this.writeManifest(m)
        imported++
      } else {
        burned++
      }
      toDelete.push(att.messageId)
    }
    if (toDelete.length && this.deleteMails) {
      try {
        await this.deleteMails(toDelete)
      } catch (err) {
        return { imported, burned, pending, error: `信道焚毁失败：${err instanceof Error ? err.message : String(err)}` }
      }
    }
    if (imported > 0) this.deps.event({ type: 'ghost-changed' })

    // 匿名中继收取：GET 即取走即焚（服务端不留副本，无信道需要销毁）
    let relayImported = 0
    const relay = this.relayUrl()
    if (relay) {
      try {
        const envs = await relayPoll(relay, JSON.parse(this.deps.appStore.loadSecret('ghost:identity') || '{}').spki ?? '')
        for (const json of envs) {
          let env: GhostEnvelope
          try {
            env = parseEnvelope(json)
          } catch {
            continue
          }
          if (!isAddressedTo(env, this.privKeyB64())) continue
          const id = randomUUID()
          const file = `${id}${EXT}`
          writeFileSync(join(this.ghostDir, file), json)
          const m = this.readManifest()
          m.items.push({ id, file, receivedAt: Date.now(), sealedBytes: Buffer.byteLength(json) })
          this.writeManifest(m)
          relayImported++
        }
        if (relayImported > 0) this.deps.event({ type: 'ghost-changed' })
      } catch {
        // 中继不可达不阻塞邮箱通道扫描结果
      }
    }

    return { imported: imported + relayImported, burned, pending }
  }
}