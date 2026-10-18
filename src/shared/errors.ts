/**
 * 错误分类（主进程与渲染进程共用）。
 *
 * 约定：主进程抛出的 AI 错误 message 以 AI_ERROR_TEXT 中的固定句子开头（后面可带括号补充细节），
 * 渲染端按这些固定句子识别类别——不在 message 里塞可见的机器前缀，现有直接展示 err.message 的地方不受影响。
 * 同时兼容旧文案 / 原始英文错误（fetch failed、AI 请求失败 (401) 等），保证任何路径都能归类。
 */

export type AIErrorKind =
  | 'unconfigured'
  | 'network-local'
  | 'network'
  | 'auth'
  | 'model'
  | 'quota'
  | 'server'
  | 'timeout'
  | 'unknown'

/** 每类 AI 错误的固定开头句（主进程据此构造 message，渲染端据此识别） */
export const AI_ERROR_TEXT: Record<Exclude<AIErrorKind, 'unknown'>, string> = {
  unconfigured: '还没有配置 AI',
  'network-local': '连不上本机的 Ollama / LM Studio，确认它在运行',
  network: '连不上 AI 服务，检查网络或代理',
  auth: 'API Key 无效或没有权限',
  model: '模型名不存在',
  quota: '请求太频繁或额度用完',
  server: 'AI 服务暂时出错，稍后再试',
  timeout: 'AI 响应超时'
}

/** 按 HTTP 状态码与响应正文归类（主进程构造错误、渲染端兜底解析共用） */
export function aiKindFromHttp(status: number, body = ''): AIErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402 || status === 429) return 'quota'
  if (status === 404) return 'model'
  if (status >= 500) return 'server'
  if (/model[^a-z]*(not[_ ]?found|not[_ ]?exist|does not exist|invalid)|model_not_found|模型不存在|模型.*不存在/i.test(body)) return 'model'
  if (/insufficient|quota|balance|rate.?limit|余额|额度/i.test(body)) return 'quota'
  if (/invalid.*(api.?key|token)|unauthori[sz]ed|authentication/i.test(body)) return 'auth'
  return 'unknown'
}

/** 识别一条错误文本属于哪类 AI 错误；不是 AI 错误返回 'unknown' */
export function classifyAIError(message: string): AIErrorKind {
  const msg = message || ''
  for (const [kind, text] of Object.entries(AI_ERROR_TEXT)) if (msg.includes(text)) return kind as AIErrorKind
  // 旧文案（insights / agent / aiStatus 等主进程既有提示）
  if (/AI 未启用|AI 未开启|AI 未配置|未配置 API Key|AI 还没配置/.test(msg)) return 'unconfigured'
  const http = msg.match(/AI 请求失败 \((\d{3})\)[:：]?\s*([\s\S]*)/)
  if (http) return aiKindFromHttp(Number(http[1]), http[2])
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|UND_ERR_SOCKET/i.test(msg)) return 'network'
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(msg)) return 'timeout'
  return 'unknown'
}

// ---------- 账户（IMAP / SMTP）错误 ----------

export type AccountErrorKind = 'auth' | 'network' | 'server' | 'tls' | 'unknown'

/**
 * 账户状态文本 → 错误类别。输入既可能是 friendlyError 的中文结果，也可能是原始英文（兜底分支 slice 出来的）。
 * 顺序有意义：授权 > TLS > 网络 > 服务器（「连接超时，请检查网络或服务器地址」属于网络）。
 */
export function classifyAccountError(text: string): AccountErrorKind {
  const t = text || ''
  if (/授权|登录失败|登录凭证|补密码|重新输入密码|AUTHENTICATIONFAILED|AUTHENTICATE|auth|credentials|invalid (user|login|password)/i.test(t)) return 'auth'
  if (/TLS|SSL|证书|certificate|handshake|WRONG_VERSION/i.test(t)) return 'tls'
  if (/超时|无法解析|网络|离线|Bridge|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|socket|timeout|Connection (closed|not available)/i.test(t)) return 'network'
  if (/限流|拒绝|服务器|THROTTLED|OVERQUOTA|ECONNREFUSED|too many|rate limit|\bNO\b|\bBAD\b/i.test(t)) return 'server'
  return 'unknown'
}
