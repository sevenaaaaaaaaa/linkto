/**
 * 验证码 / 登录链接检测（纯函数，渲染进程本地执行，零成本）
 * 典型场景：验证码邮件弹出气泡一键复制；登录/魔法链接邮件一键直达。
 */

export interface AuthExtract {
  kind: 'code' | 'login'
  code?: string
  url?: string
  provider?: string
}

const CODE_HINT =
  /(验证码|校验码|动态码|确认码|安全码|verification code|security code|one[- ]time (?:code|password)|otp|2fa|登录码|auth code|confirmation code)/i
const LOGIN_HINT =
  /(登录|登陆|log ?in|sign[- ]?in|magic[- ]?link|verify|confirm|activate|账户验证|验证账户|工作区|安全链接)/i

/** 防误报：这些场景不是登录验证 */
const NEGATIVE = /(快递|物流|订单已发货|航班|行程|工资|对账单已生成)/

const CODE_PATTERNS: RegExp[] = [
  // 关键词附近的 6 位数字（最常见的 TOTP 形态）
  /(?:验证码|校验码|动态码|确认码|code|otp)[^\dA-Z]{0,24}([0-9]{6})/i,
  /([0-9]{6})[^\dA-Z]{0,24}(?:验证码|校验码|动态码|确认码|is your code)/i,
  // 4-8 位数字
  /(?:验证码|校验码|动态码|确认码|code|otp)[^\dA-Z]{0,24}([0-9]{4,8})/i,
  /([0-9]{4,8})[^\dA-Z]{0,24}(?:验证码|校验码|动态码|确认码|is your code)/i,
  // 字母数字混合码（如 AB7K2Q）
  /(?:验证码|校验码|code|otp)[^\dA-Z]{0,24}\b([A-Z0-9]{5,8})\b/,
  /(?:code is|验证码[^\dA-Za-z]{0,8})\s*([A-Z0-9]{5,8})\b/
]

const LOGIN_URL_RE =
  /https?:\/\/[^\s"'<>]*\b(?:login|sign[- ]?in|signin|verify|verification|confirm|magic|activate|auth(?:enticate|orize)?|token|reset|continue)\b[^\s"'<>]*/i

function providerFrom(host: string): string {
  const m = host.match(/(?:^|\.)([a-z0-9-]+)\.(?:com|cn|net|org|io|co|app|dev|ai|me|cc|tv)/i)
  return (m?.[1] ?? host).replace(/^www\./, '')
}

/** 从主题 + 正文（文本或 HTML）中提取验证码 / 登录链接 */
export function detectAuth(subject: string, body: string, html?: string | null, fromAddr?: string): AuthExtract | null {
  const hay = `${subject}\n${body.slice(0, 4000)}`
  if (NEGATIVE.test(hay)) return null

  if (CODE_HINT.test(hay)) {
    for (const re of CODE_PATTERNS) {
      const m = hay.match(re)
      if (m?.[1]) {
        // 排除年份/金额一类的误报
        const code = m[1]
        if (/^(19|20)\d{2}$/.test(code)) continue
        return { kind: 'code', code }
      }
    }
  }

  if (LOGIN_HINT.test(hay) || LOGIN_HINT.test(subject)) {
    const urls: string[] = []
    if (html) {
      for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) urls.push(m[1])
    }
    urls.push(...(body.match(/https?:\/\/[^\s<>"]+/g) ?? []))
    const candidates = urls.filter(u => LOGIN_URL_RE.test(u))
    // 宽词表准入 + 登录类 URL 必要条件，二者同时满足才判定，避免误报
    if (!candidates.length) return null
    const sameDomain = fromAddr?.split('@')[1]
    const pick =
      (sameDomain ? candidates.find(u => u.includes(sameDomain)) : undefined) ??
      candidates[0] ??
      urls.find(u => !/unsubscribe|privacy|terms|blog|help|support/i.test(u))
    try {
      return { kind: 'login', url: pick, provider: providerFrom(new URL(pick!).host) }
    } catch {
      return { kind: 'login', url: pick }
    }
  }

  return null
}

/** 列表角标用：仅凭主题快速判断（零开销） */
export function subjectIsAuth(subject: string): boolean {
  return CODE_HINT.test(subject) || /验证码|校验码/.test(subject) || (LOGIN_HINT.test(subject) && NEGATIVE.test(subject) === false)
}
