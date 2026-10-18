/**
 * 网盘归档路径模板（纯函数）。
 * 模板相对网盘根目录（网盘根默认 /LinkTo），默认：附件/{分类}/{年份}/{对方}/{日期}_{文件名}
 * 变量（中英文均可）：{分类|category} {年份|year} {月份|month} {日期|date} {对方|party}
 *                    {发件人|sender} {账户|account} {文件名|filename} {主题|subject}
 */

export interface PathVars {
  category: string
  date: number
  party: string
  sender: string
  account: string
  filename: string
  subject: string
}

const ALIASES: Record<string, keyof PathVars | 'year' | 'month' | 'day'> = {
  分类: 'category',
  category: 'category',
  年份: 'year',
  year: 'year',
  月份: 'month',
  month: 'month',
  日期: 'day',
  date: 'day',
  对方: 'party',
  party: 'party',
  公司: 'party',
  发件人: 'sender',
  sender: 'sender',
  账户: 'account',
  account: 'account',
  文件名: 'filename',
  filename: 'filename',
  主题: 'subject',
  subject: 'subject'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 单个路径段安全化：去掉分隔符 / 控制字符 / 首尾点与空格，限制长度 */
export function sanitizeSegment(s: string, max = 80): string {
  let out = String(s ?? '')
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  if (out.length > max) out = out.slice(0, max).trim()
  return out || '_'
}

/** 文件名安全化：保留扩展名，主体超长时截断主体 */
export function sanitizeFilename(name: string, max = 120): string {
  const clean = sanitizeSegment(name, 1000)
  if (clean.length <= max) return clean
  const m = /(\.[a-z0-9]{1,10})$/i.exec(clean)
  const ext = m ? m[1] : ''
  return clean.slice(0, max - ext.length).trim() + ext
}

/** 渲染模板，返回以 / 开头的相对路径；未知变量原样保留成字面量（安全化后） */
export function renderPathTemplate(template: string, v: PathVars): string {
  const d = new Date(v.date || Date.now())
  const values: Record<string, string> = {
    category: v.category,
    year: String(d.getFullYear()),
    month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    party: v.party || '未知',
    sender: v.sender || v.party || '未知',
    account: v.account,
    filename: v.filename,
    subject: (v.subject || '无主题').slice(0, 40)
  }
  const tpl = (template || '').trim() || '附件/{分类}/{年份}/{对方}/{日期}_{文件名}'
  const segs = tpl
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
  if (!segs.length) segs.push('{文件名}')
  // 末段必须带文件名：模板没写 {文件名} 时自动补上
  const lastHasName = /\{(文件名|filename)\}/.test(segs[segs.length - 1])
  if (!lastHasName) segs.push('{文件名}')
  const rendered = segs.map((seg, i) => {
    const raw = seg.replace(/\{([^{}]+)\}/g, (_m, key: string) => {
      const k = ALIASES[key.trim()]
      return k ? values[k] ?? '' : key
    })
    return i === segs.length - 1 ? sanitizeFilename(raw) : sanitizeSegment(raw)
  })
  return '/' + rendered.join('/')
}

/** 同名不同内容：在扩展名前加序号 → 名称 (2).pdf */
export function withSerial(path: string, n: number): string {
  if (n <= 1) return path
  const slash = path.lastIndexOf('/')
  const dir = path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const m = /^(.*?)(\.[a-z0-9]{1,10})?$/i.exec(name)
  const stem = m?.[1] ?? name
  const ext = m?.[2] ?? ''
  return `${dir}${stem} (${n})${ext}`
}

/** 把相对路径列表折叠成目录树（预览用；纯数据） */
export interface PathTreeNode {
  name: string
  count: number
  bytes: number
  children: PathTreeNode[]
}

export function buildPathTree(items: { path: string; size: number }[]): PathTreeNode {
  const root: PathTreeNode = { name: '', count: 0, bytes: 0, children: [] }
  for (const it of items) {
    const parts = it.path.split('/').filter(Boolean)
    let node = root
    node.count++
    node.bytes += it.size
    for (const p of parts.slice(0, -1)) {
      let child = node.children.find(c => c.name === p)
      if (!child) {
        child = { name: p, count: 0, bytes: 0, children: [] }
        node.children.push(child)
      }
      child.count++
      child.bytes += it.size
      node = child
    }
  }
  return root
}
