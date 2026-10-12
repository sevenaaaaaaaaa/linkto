import * as Keychain from 'react-native-keychain'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256Hex } from './sha256'

/**
 * 守卫：主密码 + 阶梯焚毁 + 中间人即焚
 *
 * 策略（用户选定「阶梯式」）：
 *  - 主密码错 1-4 次：立即失败
 *  - 错 5 次：锁定 15 分钟；之后每再错 5 次，锁定时间翻倍（15m → 30m → 60m…）
 *  - 累计错满 15 次：焚毁 —— 删除钥匙串主密钥/守卫/全部账户凭据 + 本地账户数据，物理不可恢复
 *  - 解锁成功：失败计数清零
 *
 * 中间人即焚（用户原始需求「试图中间读取就焚毁」的可检测子集）：
 *  - IMAP/服务器 TLS 证书校验失败（自签/劫持/抓包）= 确证中间人 → 立即焚毁
 *  - 焚毁只作用于本地（凭据与账户索引）；服务器上的邮件焚不掉
 *
 * 存储结构（全部在系统钥匙串，受设备锁屏/安全隔区保护）：
 *  - linkto.master.key   主密钥（随机 32B b64）——焚毁后凭据失去保护伞
 *  - linkto.master.guard 守卫 { salt, verifier, fails, lockUntil, lockRound }
 *  - linkto.imap.<accId> 各账户 IMAP 凭据
 */

const KEY_SERVICE = 'linkto.master.key'
const GUARD_SERVICE = 'linkto.master.guard'
const ACCOUNTS_KEY = 'linkto.accounts.v1'

export const BURN_AT_FAILS = 15
const LOCK_EVERY = 5
const LOCK_BASE_MS = 15 * 60 * 1000

interface Guard {
  salt: string
  verifier: string
  fails: number
  lockUntil: number
  lockRound: number
}

async function keychainSet(service: string, value: string): Promise<void> {
  await Keychain.setGenericPassword('guard', value, { service })
}

async function keychainGet(service: string): Promise<string | null> {
  const r = await Keychain.getGenericPassword({ service })
  return r ? r.password : null
}

async function keychainDel(service: string): Promise<void> {
  await Keychain.resetGenericPassword({ service })
}

function verifierOf(salt: string, password: string): string {
  return sha256Hex(`${salt}||linkto-guard-v1||${password}`)
}

export type UnlockResult = 'ok' | 'wrong' | 'locked' | 'burned'

export interface GuardState {
  initialized: boolean
  lockedUntil: number
  fails: number
}

/** 查询守卫状态（决定首屏：设置主密码 / 解锁 / 已就绪） */
export async function guardState(): Promise<GuardState> {
  const raw = await keychainGet(GUARD_SERVICE)
  if (!raw) return { initialized: false, lockedUntil: 0, fails: 0 }
  try {
    const g = JSON.parse(raw) as Guard
    return { initialized: true, lockedUntil: g.lockUntil ?? 0, fails: g.fails ?? 0 }
  } catch {
    return { initialized: false, lockedUntil: 0, fails: 0 }
  }
}

/** 首次设置主密码（幂等：已初始化则拒绝） */
export async function setupMaster(password: string): Promise<string | null> {
  if (password.length < 4) return '主密码至少 4 位'
  const existing = await keychainGet(GUARD_SERVICE)
  if (existing) return '主密码已设置'
  const salt = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const key = randomB64()
  await keychainSet(KEY_SERVICE, key)
  const g: Guard = { salt, verifier: verifierOf(salt, password), fails: 0, lockUntil: 0, lockRound: 0 }
  await keychainSet(GUARD_SERVICE, JSON.stringify(g))
  return null
}

function randomB64(): string {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return btoa(String.fromCharCode(...Array.from(bytes)))
}

/**
 * 主密码解锁。返回：
 *  - 'ok'：解锁成功（失败计数清零）
 *  - 'wrong'：未达锁定线
 *  - 'locked'：已达 5 次线，处于锁定期（附 lockUntil）
 *  - 'burned'：累计满 15 次 → 已焚毁
 */
export async function unlock(password: string): Promise<{ result: UnlockResult; lockUntil?: number; remaining?: number }> {
  const raw = await keychainGet(GUARD_SERVICE)
  if (!raw) return { result: 'burned' }
  const g = JSON.parse(raw) as Guard
  const now = Date.now()
  if (g.lockUntil > now) return { result: 'locked', lockUntil: g.lockUntil, remaining: BURN_AT_FAILS - g.fails }

  if (verifierOf(g.salt, password) === g.verifier) {
    await keychainSet(GUARD_SERVICE, JSON.stringify({ ...g, fails: 0, lockUntil: 0, lockRound: 0 }))
    return { result: 'ok' }
  }

  const fails = g.fails + 1
  if (fails >= BURN_AT_FAILS) {
    await burnAll('password-attempts')
    return { result: 'burned' }
  }
  let lockUntil = 0
  let lockRound = g.lockRound ?? 0
  if (fails % LOCK_EVERY === 0) {
    lockRound++
    lockUntil = now + LOCK_BASE_MS * Math.pow(2, lockRound - 1)
  }
  await keychainSet(GUARD_SERVICE, JSON.stringify({ ...g, fails, lockUntil, lockRound }))
  if (lockUntil > now) return { result: 'locked', lockUntil, remaining: BURN_AT_FAILS - fails }
  return { result: 'wrong', remaining: BURN_AT_FAILS - fails }
}

/** 焚毁：主密钥 + 守卫 + 全部账户凭据 + 本地账户索引。物理不可恢复。 */
export async function burnAll(reason: string): Promise<void> {
  // 先读账户索引拿到全部凭据 service，再逐个删除
  try {
    const raw = await AsyncStorage.getItem(ACCOUNTS_KEY)
    const accounts = raw ? (JSON.parse(raw) as Array<{ id: string }>) : []
    for (const a of accounts) await keychainDel(`linkto.imap.${a.id}`)
  } catch { /* 索引损坏也要继续焚毁 */ }
  await keychainDel(KEY_SERVICE)
  await keychainDel(GUARD_SERVICE)
  await AsyncStorage.removeItem(ACCOUNTS_KEY)
  await AsyncStorage.removeItem('linkto.guard.notes')
  void reason
}

/**
 * 中间人判定：TLS 证书校验失败特征。
 * react-native-tcp-socket（OpenSSL）证书类错误消息含 cert/ssl/handshake 等关键词；
 * 与「网络不通 / 超时」严格区分，避免误焚。
 */
export function isMitmError(message: string): boolean {
  return /cert|ssl|tls|handshake|self.?signed|verify/i.test(message)
}