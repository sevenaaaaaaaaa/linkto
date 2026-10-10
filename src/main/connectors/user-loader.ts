import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectorActionDef, ConnectorManifest } from '@shared/types'
import type { AppStore } from '../store'
import type { BuiltinConnector, ConnectorExecutor } from './builtin'

/**
 * 用户自定义连接器：声明式 JSON（~dataDir/connectors/<id>.json）+ 统一 Intake 执行器。
 * 不执行任意代码——连接器只描述「往哪个 HTTP 入口发什么」，语义与 OpenFlow 家族连接器一致。
 */

export interface UserConnectorFile {
  id: string
  name: string
  description: string
  icon?: string
  color?: string
  auth?: 'none' | 'apiKey' | 'webhook'
  /** 鉴权 HTTP 头名（auth 为 apiKey/webhook 时生效） */
  headerName?: string
  /** Intake 端点（可被实例配置的 endpoint 覆盖） */
  endpoint: string
  settingsFields?: ConnectorManifest['settingsFields']
  actions: ConnectorActionDef[]
}

const RESERVED_IDS = new Set(['generic-webhook', 'clipboard', 'openflow-core', 'inflow', 'learnflow', 'mflow', 'payflow'])

function validateUserConnector(json: unknown): { ok: true; data: UserConnectorFile } | { ok: false; error: string } {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'JSON 必须是对象' }
  const m = json as Partial<UserConnectorFile>
  if (!m.id || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(m.id))
    return { ok: false, error: 'id 必填，小写字母/数字/短横线，2–32 字符' }
  if (RESERVED_IDS.has(m.id)) return { ok: false, error: `id "${m.id}" 与内置连接器冲突` }
  if (!m.name || typeof m.name !== 'string') return { ok: false, error: 'name 必填' }
  if (!m.description || typeof m.description !== 'string') return { ok: false, error: 'description 必填' }
  if (!Array.isArray(m.actions) || m.actions.length === 0) return { ok: false, error: 'actions 至少定义一个动作' }
  for (const a of m.actions) {
    if (!a?.id || !a?.name) return { ok: false, error: '每个 action 需要 id 与 name' }
  }
  if (!m.endpoint || !/^https?:\/\//i.test(m.endpoint)) return { ok: false, error: 'endpoint 必填且必须是 http(s) 地址' }
  return { ok: true, data: m as UserConnectorFile }
}

/** 通用执行器：POST <endpoint>（实例 config.endpoint 可覆盖），鉴权头 + 统一信封 */
function makeUserExec(data: UserConnectorFile): ConnectorExecutor {
  return async (actionId, params, config, payload) => {
    const endpoint = config.endpoint || data.endpoint
    if (!/^https?:\/\//i.test(endpoint)) throw new Error('Intake 端点无效')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const auth = data.auth ?? 'none'
    const headerName = data.headerName || 'X-Api-Key'
    if (auth === 'apiKey' || auth === 'webhook') {
      const key = config.apiKey
      if (!key) throw new Error('未配置鉴权 Key')
      headers[headerName] = key
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ product: data.id, action: actionId, params, payload, sentAt: Date.now() })
    })
    if (!res.ok) throw new Error(`${data.name} 返回 ${res.status}`)
    return { ok: true }
  }
}

export function userConnectorPath(appStore: AppStore, id: string): string {
  return join(appStore.connectorsDir, `${id.replace(/[^a-z0-9-]/gi, '')}.json`)
}

/** 扫描用户目录，加载全部合法连接器（非法 JSON / 校验失败自动跳过） */
export function loadUserConnectors(appStore: AppStore): BuiltinConnector[] {
  if (!existsSync(appStore.connectorsDir)) return []
  const out: BuiltinConnector[] = []
  for (const file of readdirSync(appStore.connectorsDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const json = JSON.parse(readFileSync(join(appStore.connectorsDir, file), 'utf8')) as unknown
      const v = validateUserConnector(json)
      if (!v.ok) continue
      const manifest: ConnectorManifest = {
        id: v.data.id,
        name: v.data.name,
        description: v.data.description,
        icon: v.data.icon ?? '🔌',
        color: v.data.color ?? '#64748b',
        auth: v.data.auth ?? 'none',
        settingsFields: v.data.settingsFields,
        actions: v.data.actions
      }
      out.push({ manifest, exec: makeUserExec(v.data) })
    } catch {
      /* 解析失败跳过 */
    }
  }
  return out
}

/** 安装：校验 + 落盘（同名覆盖） */
export function installUserConnector(appStore: AppStore, jsonText: string): { ok: boolean; error?: string; id?: string } {
  let json: unknown
  try {
    json = JSON.parse(jsonText)
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
  const v = validateUserConnector(json)
  if (!v.ok) return { ok: false, error: v.error }
  try {
    writeFileSync(userConnectorPath(appStore, v.data.id), JSON.stringify(v.data, null, 2))
    return { ok: true, id: v.data.id }
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 卸载：删除 manifest 文件（实例配置由调用方清理） */
export function removeUserConnector(appStore: AppStore, id: string): { ok: boolean; error?: string } {
  const path = userConnectorPath(appStore, id)
  if (!existsSync(path)) return { ok: false, error: '未找到该连接器' }
  try {
    unlinkSync(path)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `删除失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 已装清单（含解析失败标记，便于 UI 提示修复） */
export function listUserConnectorFiles(appStore: AppStore): { id: string; name: string; error?: string }[] {
  if (!existsSync(appStore.connectorsDir)) return []
  const out: { id: string; name: string; error?: string }[] = []
  for (const file of readdirSync(appStore.connectorsDir)) {
    if (!file.endsWith('.json')) continue
    const path = join(appStore.connectorsDir, file)
    try {
      const v = validateUserConnector(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (v.ok) out.push({ id: v.data.id, name: v.data.name })
      else out.push({ id: file, name: file, error: v.error })
    } catch (e) {
      out.push({ id: file, name: file, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }
  return out
}

/** 示例 manifest（设置页一键填充 textarea） */
export const USER_CONNECTOR_TEMPLATE = JSON.stringify(
  {
    id: 'my-notion',
    name: '我的 Notion',
    description: '把邮件一键存入我的 Notion 数据库。',
    icon: 'N',
    color: '#111111',
    auth: 'apiKey',
    headerName: 'X-Api-Key',
    endpoint: 'https://api.example.com/intake',
    settingsFields: [{ key: 'database', label: '数据库 ID', type: 'text' }],
    actions: [{ id: 'save-email', name: '存入 Notion', params: [{ key: 'page', label: '目标页面（可选）', type: 'text' }] }]
  },
  null,
  2
)