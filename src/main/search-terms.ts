/**
 * 自然语言问句 → 检索词。中文没有空格，整句检索几乎不命中：
 * 去掉疑问/虚词后，中文连续段切成重叠二元组（bigram），英文/数字按词保留。
 */

const STOP_PHRASES = [
  '什么时候', '是什么', '什么', '怎么样', '怎么', '如何', '为什么', '是否', '有没有', '哪些', '哪个', '哪里', '多少', '几个',
  '帮我', '请问', '请', '一下', '告诉我', '我想知道', '关于', '有关', '相关', '的话', '之前', '上次', '最近', '上周', '这周',
  '本周', '今天', '昨天', '时候', '邮件', '这封', '那封', '一封', '内容', '说的', '提到', '提过', '吗', '呢', '吧', '啊', '呀'
]
const STOP_CHARS = new Set([...'的了是在有和与及或也都就还又我你他她它们这那个'])

export function searchTerms(question: string, max = 12): string[] {
  let text = question.toLowerCase()
  for (const p of STOP_PHRASES) text = text.split(p).join(' ')
  const terms = new Set<string>()
  for (const word of text.match(/[a-z0-9][a-z0-9@._+-]*/g) ?? []) {
    if (word.length > 1) terms.add(word)
  }
  for (const run of text.match(/[㐀-鿿]+/g) ?? []) {
    // 在虚词处断开再切二元组，避免跨虚词拼出无意义的词
    let seg: string[] = []
    const flush = () => {
      for (let i = 0; i + 1 < seg.length; i++) terms.add(seg[i] + seg[i + 1])
      seg = []
    }
    for (const c of run) {
      if (STOP_CHARS.has(c)) flush()
      else seg.push(c)
    }
    flush()
  }
  return [...terms].slice(0, max)
}

/** 按命中检索词个数打分（标题命中加权），返回 score>0 的条目 */
export function rankByTerms<T>(items: T[], terms: string[], text: (item: T) => { title: string; body: string }): { item: T; score: number }[] {
  if (!terms.length) return []
  return items
    .map(item => {
      const { title, body } = text(item)
      const t = title.toLowerCase()
      const b = body.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (t.includes(term)) score += 2
        else if (b.includes(term)) score += 1
      }
      return { item, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
}
