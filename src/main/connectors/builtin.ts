import type { ConnectorManifest } from '@shared/types'

/**
 * 连接器框架：每个连接器由一份 Manifest 描述（鉴权方式、设置项、动作），
 * 主进程按 Manifest 执行动作。OpenFlow 家族产品以 Manifest + 统一 Intake 执行器接入（见 familyConnector）。
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

// TODO(OpenFlow): 更多家族产品连接器在此注册

/**
 * OpenFlow 家族通用连接器：声明式 Manifest + 统一执行器。
 * 每个家族产品暴露一个 Intake HTTP 入口（endpoint + X-Api-Key），
 * LinkTo 把邮件内容 POST 过去，产品侧按 product/action 落成自己的实体
 * （inFlow 建任务、LearnFlow 收学习资料、MFlow 存笔记、PayFlow 归档账单、OpenFlow 进工作台）。
 */
function familyConnector(opts: {
  manifestId: string
  name: string
  description: string
  icon: string
  color: string
  actionId: string
  actionName: string
  defaultEndpoint: string
}): BuiltinConnector {
  return {
    manifest: {
      id: opts.manifestId,
      name: opts.name,
      description: opts.description,
      icon: opts.icon,
      color: opts.color,
      auth: 'apiKey',
      settingsFields: [
        { key: 'endpoint', label: `Intake 地址（默认 ${opts.defaultEndpoint}）`, type: 'text' },
        { key: 'apiKey', label: 'API Key', required: true, type: 'text' }
      ],
      actions: [{ id: opts.actionId, name: opts.actionName }]
    },
    exec: async (actionId, params, config, payload) => {
      if (!config.apiKey) throw new Error('未配置 API Key')
      const endpoint = config.endpoint || opts.defaultEndpoint
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apiKey },
        body: JSON.stringify({
          product: opts.manifestId,
          action: actionId,
          params,
          payload,
          sentAt: Date.now()
        })
      })
      if (!res.ok) throw new Error(`${opts.name} 返回 ${res.status}`)
      return { ok: true }
    }
  }
}

const OPENFLOW_CORE = familyConnector({
  manifestId: 'openflow-core',
  name: 'OpenFlow 工作台',
  description: '把邮件（需求、灵感、纪要）一键发往 OpenFlow 主站工作台，成为可追踪的工作流条目。',
  icon: '🌊',
  color: 'oklch(52% .17 258)',
  actionId: 'intake',
  actionName: '发往工作台',
  defaultEndpoint: 'https://openflow.example.com/api/intake'
})

const INFLOW = familyConnector({
  manifestId: 'inflow',
  name: 'inFlow 任务',
  description: '把一封需求 / 待办邮件转成 inFlow 任务卡，标题带主题、描述带正文。',
  icon: '✅',
  color: '#059669',
  actionId: 'save-task',
  actionName: '转成任务',
  defaultEndpoint: 'http://localhost:8871/api/intake'
})

const LEARNFLOW = familyConnector({
  manifestId: 'learnflow',
  name: 'LearnFlow 学习',
  description: '把课程通知、学习资料邮件收藏进 LearnFlow，自动归入对应课程。',
  icon: '🎓',
  color: '#7c3aed',
  actionId: 'save-material',
  actionName: '收藏为学习资料',
  defaultEndpoint: 'http://localhost:8872/api/intake'
})

const MFLOW = familyConnector({
  manifestId: 'mflow',
  name: 'MFlow 笔记',
  description: '把邮件正文沉淀为 MFlow 知识卡片，与邮件互相引用。',
  icon: '📝',
  color: '#d97706',
  actionId: 'save-note',
  actionName: '存为笔记',
  defaultEndpoint: 'http://localhost:8873/api/intake'
})

const PAYFLOW = familyConnector({
  manifestId: 'payflow',
  name: 'PayFlow 账单',
  description: '识别账单 / 发票 / 收据邮件，转发给 PayFlow 归档与对账。',
  icon: '💳',
  color: '#0ea5e9',
  actionId: 'save-invoice',
  actionName: '归档账单',
  defaultEndpoint: 'http://localhost:8874/api/intake'
})

export const BUILTIN_CONNECTORS: BuiltinConnector[] = [
  GENERIC_WEBHOOK,
  CLIPBOARD,
  OPENFLOW_CORE,
  INFLOW,
  LEARNFLOW,
  MFLOW,
  PAYFLOW
]
