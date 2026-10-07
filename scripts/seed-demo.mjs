#!/usr/bin/env node
/** 向运行中应用的 SQLite 注入模拟邮件（WAL 多进程并发） */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('/tmp/ms-test-data/mail-studio/mail.db')

const now = Date.now()
const acc = 'acc-test'
db.prepare(
  `INSERT OR REPLACE INTO accounts (id, provider, name, email, color, enabled, signature_id,
    imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, user, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(acc, 'gmail', 'Seven Gmail', 'seven@gmail.com', '#22c55e', 1, null,
  'imap.gmail.com', 993, 1, 'smtp.gmail.com', 465, 1, 'seven@gmail.com', now)

db.prepare(
  `INSERT OR REPLACE INTO folders (id, account_id, path, name, special, sort_order, hidden, total, unread, last_sync_uid, uid_validity)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
).run(`${acc}::INBOX`, acc, 'INBOX', '收件箱', 'inbox', 0, 0, 3, 2, 100, 1)

const mails = [
  {
    id: `${acc}::INBOX::1`, uid: 1,
    from_name: '王小明', from_addr: 'xiaoming@partner.co', subject: '关于 Q4 联合推广方案的建议',
    text: 'Seven 你好，\n\n关于 Q4 的联合推广，我整理了三个方向：\n1. 与设计社区联合举办活动\n2. 联名内容共创\n3. 交叉投放\n\n周三下午3点电话聊一下？\n\n王小明',
    snippet: '关于 Q4 的联合推广，我整理了三个方向：1. 与设计社区联合举办活动 2. 联名内容共创…',
    category: 'personal', nl: 0, unread: 1, mins: 30, html: '<p>Seven 你好：</p><p>关于 <b>Q4 联合推广</b>，我整理了三个方向：</p><ul><li>与设计社区联合举办活动</li><li>联名内容共创</li><li>交叉投放</li></ul><p>周三下午3点电话聊一下？</p><p>王小明</p>'
  },
  {
    id: `${acc}::INBOX::2`, uid: 2,
    from_name: 'GitHub', from_addr: 'noreply@github.com', subject: '[GitHub] 你的 weekly digest 已生成',
    text: '这是你本周的仓库动态汇总。', snippet: '这是你本周的仓库动态汇总。',
    category: 'notification', nl: 0, unread: 1, mins: 240, html: '<p>这是你本周的仓库动态汇总。</p>'
  },
  {
    id: `${acc}::INBOX::3`, uid: 3,
    from_name: 'Design Weekly', from_addr: 'newsletter@designweekly.co', subject: 'Vol.128: AI 时代的设计系统',
    text: '本周精选：AI 时代的设计系统、Figma 新功能、12 个动效案例。', snippet: '本周精选：AI 时代的设计系统、Figma 新功能、12 个动效案例。',
    category: 'newsletter', nl: 1, unread: 0, mins: 1500, html: '<p>本周精选：</p><p><b>AI 时代的设计系统</b>、Figma 新功能、12 个动效案例。</p>'
  }
]

for (const m of mails) {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, account_id, folder_id, folder_path, uid, thread_id, message_id, in_reply_to,
      references_txt, from_name, from_addr, to_json, cc_json, reply_to_json, subject, norm_subject, snippet, text, html,
      date, size, flags, has_attachments, category, is_newsletter, list_unsubscribe, list_id, saved_kb, ai_summarized, body_fetched, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    m.id, acc, `${acc}::INBOX`, 'INBOX', m.uid, m.id, `<${m.id}@test>`, null, '[]',
    m.from_name, m.from_addr, '[]', '[]', null, m.subject, m.subject.toLowerCase(), m.snippet, m.text, m.html,
    now - m.mins * 60000, 2048, m.unread ? '' : '\\Seen', 0, m.category, m.nl,
    m.nl ? '<https://designweekly.co/unsubscribe>' : null, m.nl ? 'designweekly.co' : null, 0, 0, 1, now
  )
  if (m.nl) {
    db.prepare(
      `INSERT OR REPLACE INTO newsletter_senders (account_id, sender, subscribed, count, latest_at) VALUES (?,?,1,1,?)`
    ).run(acc, m.from_addr, now)
  }
}

const c = db.prepare('SELECT COUNT(*) AS c FROM messages').get()
console.log(`injected, total messages: ${c.c}`)
db.close()
