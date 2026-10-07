import type { ConnectorManifest } from '@shared/types'

/**
 * 连接器框架：每个连接器由一份 Manifest 描述（鉴权方式、设置项、动作），
 * 主进程按 Manifest 执行动作。OpenFlow 家族产品后续以新 Manifest + 执行器接入。
 */
export type ConnectorExecutor = (
  actionId: string,
  params: Record<string, string>,
  config: Record<string, string>,
  payload?: unknown
) => Promise<unknown>

export interface BuiltinConnector {
  manifest: ConnectorManifest
  exec: ConnectorExecutor
}

const GENERIC_WEBHOOK: BuiltinConnector = {
  manifest: {
    id: 'generic-webhook',
    name: '通用 Webhook',
    description: '把邮件内容转发到任意 HTTP 接口（自动化工作流的万能入口）。',
    icon: '⚡',
    color: '#8b5cf6',
    auth: 'webhook',
    settingsFields: [{ key: 'url', label: 'Webhook URL', required: true, type: 'text' }],
    actions: [
      {
        id: 'forward',
        name: '转发邮件内容',
        params: [
          { key: 'note', label: '备注（可选）', type: 'textarea' }
        ]
      }
    ]
  },
  exec: async (actionId, params, config, payload) => {
    if (!config.url) throw new Error('未配置 Webhook URL')
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: actionId, params, payload, sentAt: Date.now() })
    })
    if (!res.ok) throw new Error(`Webhook 返回 ${res.status}`)
    return { ok: true }
  }
}

const CLIPBOARD: BuiltinConnector = {
  manifest: {
    id: 'clipboard',
    name: '系统剪贴板',
    description: '将邮件正文或选中文本快速复制到剪贴板，便于粘贴到其他应用。',
    icon: '📋',
    color: '#0ea5e9',
    auth: 'none',
    actions: [{ id: 'copy-text', name: '复制内容' }]
  },
  exec: async (_actionId, _params, _config, payload) => {
    const { clipboard } = await import('electron')
    clipboard.writeText(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))
    return { ok: true }
  }
}

// TODO(OpenFlow): OpenFlow 家族产品连接器在此注册
export const BUILTIN_CONNECTORS: BuiltinConnector[] = [GENERIC_WEBHOOK, CLIPBOARD]
