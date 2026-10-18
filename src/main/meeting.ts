import type { TodoMeeting } from '@shared/types'

/**
 * 视频会议识别：从邮件正文 / HTML / 日历邀请（.ics）里找出入会链接、会议号和开始时间。
 * 纯函数（不碰数据库与文件系统），便于单测；调用方负责读取 ics 附件内容。
 */

const PROVIDERS: { provider: TodoMeeting['provider']; re: RegExp }[] = [
  { provider: 'zoom', re: /https?:\/\/[\w.-]*zoom\.(?:us|com\.cn)\/(?:j|w|my)\/[\w?=&.%-]+/i },
  { provider: 'teams', re: /https?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>]+/i },
  { provider: 'meet', re: /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i },
  { provider: 'tencent', re: /https?:\/\/meeting\.tencent\.com\/(?:dm|s|p)\/[\w-]+/i },
  { provider: 'feishu', re: /https?:\/\/(?:vc\.feishu\.cn|meetings\.feishu\.cn|vc\.larksuite\.com)\/j\/\d+/i },
  { provider: 'webex', re: /https?:\/\/[\w.-]+\.webex\.com\/(?:meet|join|[\w.-]+\/j\.php)[^\s"'<>]*/i }
]

export interface IcsEvent {
  summary: string
  start: number
  end: number | null
  location: string
  url: string
  description: string
}

/** 解析 ics 文本里的第一个 VEVENT（处理折行、UTC / TZID / 全天日期） */
export function parseIcs(text: string): IcsEvent | null {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const ev = unfolded.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/)
  if (!ev) return null
  const field = (name: string) => {
    const m = ev[1].match(new RegExp(`^${name}(;[^:\\r\\n]*)?:(.*)$`, 'mi'))
    return m ? { params: m[1] ?? '', value: m[2].trim() } : null
  }
  const unescape = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
  const toTs = (f: { params: string; value: string } | null): number | null => {
    if (!f) return null
    const m = f.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
    if (!m) return null
    const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m
    if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
    const tz = f.params.match(/TZID=([^;:]+)/)?.[1]
    if (tz) {
      // 用 Intl 求该时区在该时刻的偏移，把「墙上时间」换算成 UTC
      const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess))
        const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
        const asTz = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
        return guess - (asTz - guess)
      } catch {
        /* 未知时区：按本地时间 */
      }
    }
    return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime()
  }
  const start = toTs(field('DTSTART'))
  if (!start) return null
  return {
    summary: unescape(field('SUMMARY')?.value ?? ''),
    start,
    end: toTs(field('DTEND')),
    location: unescape(field('LOCATION')?.value ?? ''),
    url: field('URL')?.value ?? '',
    description: unescape(field('DESCRIPTION')?.value ?? '')
  }
}

/** 在一段文本里找入会链接 */
export function findMeetingLink(text: string): { url: string; provider: TodoMeeting['provider'] } | null {
  for (const p of PROVIDERS) {
    const m = text.match(p.re)
    if (m) return { url: m[0].replace(/[).,;]+$/, ''), provider: p.provider }
  }
  return null
}

/** 会议号（腾讯会议 / 飞书 / Zoom 常见写法） */
function findCode(text: string): string | undefined {
  const m = text.match(/(?:会议号|会议 ID|Meeting ID|入会号)[:：\s]*([\d\s-]{6,16}\d)/i)
  return m ? m[1].replace(/\s+/g, ' ').trim() : undefined
}

/**
 * 识别一封邮件里的会议。优先用 ics 邀请里的时间；没有 ics 时用调用方给的时间（来自邮件理解的时间实体）。
 * 没有入会链接、也不是日历邀请的邮件返回 null。
 */
export function detectMeeting(input: { subject: string; text: string; html: string | null; ics?: string | null; fallbackStart?: number | null }): { title: string; meeting: TodoMeeting } | null {
  const ev = input.ics ? parseIcs(input.ics) : null
  const haystack = [ev?.url, ev?.location, ev?.description, input.text, input.html ?? ''].filter(Boolean).join('\n')
  const link = findMeetingLink(haystack)
  const start = ev?.start ?? input.fallbackStart ?? null
  if (!start || (!link && !ev)) return null
  return {
    title: (ev?.summary || input.subject || '会议').replace(/^(邀请|Invitation|已更新的邀请|Updated invitation)[:：]\s*/i, '').slice(0, 120),
    meeting: {
      url: link?.url ?? ev?.url ?? '',
      provider: link?.provider ?? 'other',
      startsAt: start,
      endsAt: ev?.end ?? null,
      code: findCode(haystack)
    }
  }
}
