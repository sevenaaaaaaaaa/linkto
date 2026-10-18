/**
 * 内置邮件模板预设库 + 占位符工具。
 * 预设只存在于前端代码中，用户点「添加到我的模板」后才写入数据库（成为可编辑的用户模板）。
 *
 * 占位符写法：{对方称呼} {我的名字} {日期}（英文模板用 {Recipient} {My Name} {Date}）。
 * 插入撰写窗时能自动填充的会被替换，其余（如 {项目名称}）原样保留，提示用户手动补全。
 */

export interface TemplatePreset {
  id: string
  category: string
  name: string
  subject: string
  html: string
}

/** 自动填充的占位符（中文 + 英文别名） */
export const AUTO_PLACEHOLDERS = ['对方称呼', '我的名字', '日期'] as const
const EN_ALIASES: Record<string, (typeof AUTO_PLACEHOLDERS)[number]> = {
  Recipient: '对方称呼',
  'My Name': '我的名字',
  Date: '日期'
}

const PLACEHOLDER_RE = /\{([^{}\n]{1,24})\}/g

/** 提取文本中出现的占位符名（去重、保序） */
export function extractPlaceholders(...texts: string[]): string[] {
  const seen = new Set<string>()
  for (const t of texts) {
    for (const m of t.matchAll(PLACEHOLDER_RE)) seen.add(m[1].trim())
  }
  return [...seen]
}

/** 是否为可自动填充的占位符 */
export function isAutoPlaceholder(name: string): boolean {
  return (AUTO_PLACEHOLDERS as readonly string[]).includes(name) || name in EN_ALIASES
}

/**
 * 替换占位符：vars 中有值的替换，没有值的原样保留。
 * escape：替换进 HTML 时转义值，避免收件人名字里的 < & 破坏结构。
 */
export function fillPlaceholders(text: string, vars: Record<string, string | undefined>, escape = false): string {
  return text.replace(PLACEHOLDER_RE, (whole, raw: string) => {
    const value = vars[raw.trim()]
    if (!value) return whole
    return escape ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : value
  })
}

/** 今天的日期：中文「2026年10月18日」/ 英文「October 18, 2026」 */
export function todayText(lang: 'zh' | 'en' = 'zh'): string {
  const d = new Date()
  if (lang === 'en') return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 组装自动填充变量（中文名 + 英文别名；缺值的键不填，占位符原样保留） */
export function buildAutoVars(input: { recipient?: string; me?: string }): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {
    对方称呼: input.recipient?.trim() || undefined,
    我的名字: input.me?.trim() || undefined,
    日期: todayText('zh')
  }
  for (const [alias, canonical] of Object.entries(EN_ALIASES)) {
    vars[alias] = alias === 'Date' ? todayText('en') : vars[canonical]
  }
  return vars
}

/** 从收件人输入框文本里取第一位的显示名（「张三 <a@b.com>」→ 张三；纯地址则无） */
export function firstRecipientName(to: string): string | undefined {
  // 支持带引号的名字（"Li, Wei" <a@b.com>）；首位收件人是纯地址时返回 undefined
  const m = to.match(/^\s*(?:"([^"]+)"|([^"<>,，;；]+?))\s*<[^>]+>/)
  return (m?.[1] ?? m?.[2])?.trim() || undefined
}

/** 纯文本段落 → 邮件 HTML（每个元素一段；数组元素内的 \n 变换行） */
function body(...paras: string[]): string {
  return paras.map(p => `<p>${p.split('\n').join('<br>')}</p>`).join('')
}

const SIGN = '祝好，\n{我的名字}'
const SIGN_EN = 'Best regards,\n{My Name}'

/** 分类顺序（也作为用户模板分类下拉的候选） */
export const PRESET_CATEGORIES = [
  '商务往来',
  '会议与日程',
  '婉拒与拒绝',
  '感谢与致歉',
  '求职与人事',
  '客服与售后',
  '个人与生活',
  'Business English'
] as const

/** 未分类模板的显示名 */
export const UNCATEGORIZED = '未分类'

/** 分类排序：预设分类在前（按预设顺序），自定义分类按名称，未分类垫底 */
export function sortTemplateCategories(cats: Iterable<string>): string[] {
  const order = (c: string) => {
    if (c === UNCATEGORIZED) return 1e6
    const i = (PRESET_CATEGORIES as readonly string[]).indexOf(c)
    return i >= 0 ? i : 1000
  }
  return [...new Set(cats)].sort((a, b) => order(a) - order(b) || a.localeCompare(b, 'zh-CN'))
}

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  // ---------- 商务往来 ----------
  {
    id: 'biz-received',
    category: '商务往来',
    name: '确认收到',
    subject: '已收到：{事项}',
    html: body(
      '{对方称呼}，您好：',
      '您发来的{事项}已收到，谢谢。我会在 {预计时间} 前完成查看并给您答复，如有需要补充的信息也会第一时间联系您。',
      SIGN
    )
  },
  {
    id: 'biz-followup',
    category: '商务往来',
    name: '跟进进度',
    subject: '跟进：{项目名称} 进展',
    html: body(
      '{对方称呼}，您好：',
      '想跟您同步一下 {项目名称} 的进展。目前我们这边已完成 {已完成事项}，接下来计划 {下一步}。',
      '想确认一下您那边 {待确认事项} 的情况，方便的话请在 {截止日期} 前告诉我，以便我们按计划推进。',
      SIGN
    )
  },
  {
    id: 'biz-payment',
    category: '商务往来',
    name: '礼貌催款',
    subject: '付款提醒：发票 {发票编号}',
    html: body(
      '{对方称呼}，您好：',
      '冒昧打扰。关于 {项目名称} 的发票 {发票编号}（金额 {金额}），约定付款日为 {约定日期}，目前我们这边尚未查到到账记录。',
      '可能是流程还在进行中，麻烦您帮忙确认一下付款进度。如已安排支付，请忽略本邮件；如需我们补充任何材料，也请随时告诉我。',
      '感谢您的支持！',
      SIGN
    )
  },
  {
    id: 'biz-quote',
    category: '商务往来',
    name: '报价回复',
    subject: '关于 {产品/服务} 的报价',
    html: body(
      '{对方称呼}，您好：',
      '感谢您对 {产品/服务} 的关注。根据您提出的需求，报价如下：',
      '· 方案内容：{方案内容}\n· 报价：{金额}（{含税说明}）\n· 交付周期：{交付周期}\n· 报价有效期：至 {有效期}',
      '详细报价单见附件。如需调整方案或有任何疑问，欢迎随时联系，我们也可以约个时间电话沟通。',
      SIGN
    )
  },
  {
    id: 'biz-intro',
    category: '商务往来',
    name: '初次联系',
    subject: '{我的公司} × {对方公司}：合作交流',
    html: body(
      '{对方称呼}，您好：',
      '我是 {我的公司} 的{我的名字}，负责 {负责领域}。关注贵司在 {对方领域} 的工作已有一段时间，我们在 {我方优势} 方面或许能为您带来帮助。',
      '不知您下周是否方便安排 20 分钟线上交流？我可以根据您的时间来调整。',
      '期待您的回复。',
      SIGN
    )
  },

  // ---------- 会议与日程 ----------
  {
    id: 'mtg-invite',
    category: '会议与日程',
    name: '会议邀约',
    subject: '会议邀请：{会议主题}',
    html: body(
      '{对方称呼}，您好：',
      '想邀请您参加关于 {会议主题} 的会议，具体安排如下：',
      '· 时间：{会议时间}\n· 时长：约 {时长}\n· 地点 / 链接：{会议地点}\n· 议程：{议程}',
      '如时间不便，请告诉我您方便的时段，我来重新安排。',
      SIGN
    )
  },
  {
    id: 'mtg-reschedule',
    category: '会议与日程',
    name: '会议改期',
    subject: '改期：{会议主题}',
    html: body(
      '{对方称呼}，您好：',
      '非常抱歉，原定于 {原时间} 的 {会议主题} 因 {原因} 需要调整。',
      '以下时间我都可以，请您选一个方便的：\n· {备选时间一}\n· {备选时间二}',
      '给您带来不便，敬请谅解。',
      SIGN
    )
  },
  {
    id: 'mtg-minutes',
    category: '会议与日程',
    name: '会后纪要',
    subject: '会议纪要：{会议主题}（{日期}）',
    html: body(
      '各位好：',
      '感谢大家参加今天的 {会议主题} 会议，纪要如下，如有遗漏或偏差请直接回复补充。',
      '一、主要结论\n{结论}',
      '二、待办事项\n· {待办一} —— 负责人：{负责人}，截止：{截止日期}\n· {待办二} —— 负责人：{负责人}，截止：{截止日期}',
      '三、下次会议\n{下次会议时间}',
      SIGN
    )
  },
  {
    id: 'mtg-decline',
    category: '会议与日程',
    name: '婉拒会议',
    subject: '回复：{会议主题}',
    html: body(
      '{对方称呼}，您好：',
      '感谢邀请。很遗憾 {会议时间} 我已有其他安排，无法参加这次会议。',
      '如果方便，会后能否把纪要或资料发我一份？有需要我提前提供的信息，也请随时告诉我。',
      SIGN
    )
  },
  {
    id: 'mtg-confirm',
    category: '会议与日程',
    name: '确认参会',
    subject: '确认参会：{会议主题}',
    html: body('{对方称呼}，您好：', '收到邀请，我会准时参加 {会议时间} 的 {会议主题}。如需提前准备材料，请告诉我。', SIGN)
  },

  // ---------- 婉拒与拒绝 ----------
  {
    id: 'no-partnership',
    category: '婉拒与拒绝',
    name: '婉拒合作',
    subject: '关于合作邀请的回复',
    html: body(
      '{对方称呼}，您好：',
      '感谢您对我们的认可以及提出的合作邀请，我们认真评估了方案。',
      '综合考虑我们当前的业务重心和资源安排，这次只能遗憾地婉拒。这并不代表对贵司方案的否定，希望今后能有更契合的机会再合作。',
      '再次感谢您的诚意。',
      SIGN
    )
  },
  {
    id: 'no-request',
    category: '婉拒与拒绝',
    name: '拒绝需求',
    subject: '关于 {需求名称} 的回复',
    html: body(
      '{对方称呼}，您好：',
      '感谢您提出 {需求名称}。经过评估，由于 {原因}，我们目前无法支持这一需求。',
      '作为替代，您可以考虑 {替代方案}。如果情况有变化，我们会第一时间通知您。',
      '谢谢理解。',
      SIGN
    )
  },
  {
    id: 'no-later',
    category: '婉拒与拒绝',
    name: '暂不考虑',
    subject: '回复：{主题}',
    html: body(
      '{对方称呼}，您好：',
      '谢谢您的介绍，内容很有参考价值。不过我们近期没有这方面的计划，暂时不考虑。',
      '我会保留您的联系方式，后续如有需要会主动联系您。',
      SIGN
    )
  },
  {
    id: 'no-unsub',
    category: '婉拒与拒绝',
    name: '谢绝推广',
    subject: '请停止发送推广邮件',
    html: body('您好：', '感谢关注。我目前对相关产品没有需求，麻烦将此邮箱从你们的发送列表中移除，谢谢。', '{我的名字}')
  },

  // ---------- 感谢与致歉 ----------
  {
    id: 'ty-thanks',
    category: '感谢与致歉',
    name: '感谢',
    subject: '谢谢您的帮助',
    html: body(
      '{对方称呼}，您好：',
      '特别感谢您在 {事项} 上的帮助。尤其是 {具体帮助}，让我们少走了很多弯路。',
      '以后有任何需要我配合的地方，请随时开口。',
      SIGN
    )
  },
  {
    id: 'ty-apology',
    category: '感谢与致歉',
    name: '致歉',
    subject: '关于 {事项} 的致歉',
    html: body(
      '{对方称呼}，您好：',
      '关于 {事项}，是我们这边的疏忽，给您带来了困扰，非常抱歉。',
      '问题的原因是 {原因}。我们已经 {已采取措施}，并会 {后续改进}，避免类似情况再次发生。',
      '再次向您致歉，感谢您的耐心与理解。',
      SIGN
    )
  },
  {
    id: 'ty-delay',
    category: '感谢与致歉',
    name: '延期说明',
    subject: '{事项} 交付时间调整说明',
    html: body(
      '{对方称呼}，您好：',
      '需要向您说明：原计划于 {原定日期} 交付的 {事项}，由于 {原因}，预计需要延期至 {新日期}。',
      '目前已完成 {当前进度}，剩余部分我们正在全力推进。延期给您带来不便，非常抱歉；期间如有任何问题，我会及时同步。',
      SIGN
    )
  },
  {
    id: 'ty-holiday',
    category: '感谢与致歉',
    name: '年终致谢',
    subject: '感谢这一年的支持',
    html: body(
      '{对方称呼}，您好：',
      '一年又将过去，感谢您这一年来的信任与支持。和您合作的每个项目都让我们收获很多。',
      '提前祝您新年快乐，期待来年继续携手！',
      SIGN
    )
  },

  // ---------- 求职与人事 ----------
  {
    id: 'hr-apply',
    category: '求职与人事',
    name: '投递简历',
    subject: '应聘 {职位名称} —— {我的名字}',
    html: body(
      '{对方称呼}，您好：',
      '我在 {招聘渠道} 看到贵司 {职位名称} 的招聘信息，非常感兴趣，特此投递简历（见附件）。',
      '我有 {年限} 年 {相关领域} 经验，曾 {代表性成果}，相信能较快为团队带来价值。',
      '期待有机会进一步沟通，感谢您抽空阅读。',
      '此致\n{我的名字}\n{联系电话}'
    )
  },
  {
    id: 'hr-interview',
    category: '求职与人事',
    name: '面试确认',
    subject: '面试确认：{职位名称}',
    html: body(
      '{对方称呼}，您好：',
      '感谢通知，我确认参加 {面试时间} 的 {职位名称} 面试（{面试形式}）。',
      '如需提前准备材料或作品，请告诉我。期待与您交流！',
      SIGN
    )
  },
  {
    id: 'hr-offer',
    category: '求职与人事',
    name: '接受录用',
    subject: '接受录用：{职位名称}',
    html: body(
      '{对方称呼}，您好：',
      '非常感谢贵司的录用通知，我很高兴地接受 {职位名称} 一职，并确认于 {入职日期} 正式入职。',
      '入职前如需准备的材料或手续，请告诉我。期待加入团队！',
      SIGN
    )
  },
  {
    id: 'hr-handover',
    category: '求职与人事',
    name: '离职交接',
    subject: '工作交接说明 —— {我的名字}',
    html: body(
      '各位好：',
      '我的最后工作日为 {最后工作日}。为保证工作顺利衔接，交接安排如下：',
      '· {工作一} → 交接给 {接手人}\n· {工作二} → 交接给 {接手人}\n· 相关文档：{文档位置}',
      '离职前我会尽量把手头事项收尾；之后如有疑问，也可以通过 {私人联系方式} 联系我。感谢大家一直以来的照顾！',
      SIGN
    )
  },
  {
    id: 'hr-thanks-interview',
    category: '求职与人事',
    name: '面试后致谢',
    subject: '感谢面试机会 —— {我的名字}',
    html: body(
      '{对方称呼}，您好：',
      '感谢您今天抽时间与我面谈 {职位名称}。交流中关于 {讨论话题} 的部分让我对团队有了更深的了解，也更期待加入。',
      '如需补充任何材料，请随时告诉我。期待您的好消息！',
      SIGN
    )
  },

  // ---------- 客服与售后 ----------
  {
    id: 'cs-ticket',
    category: '客服与售后',
    name: '工单回复',
    subject: '回复：您的工单 {工单号}',
    html: body(
      '{对方称呼}，您好：',
      '感谢您的反馈，我们已收到您的问题（工单号 {工单号}），技术同事正在排查。',
      '为便于定位，麻烦您补充：{所需信息}。我们会在 {回复时限} 内给您进一步答复。',
      SIGN
    )
  },
  {
    id: 'cs-refund',
    category: '客服与售后',
    name: '退款说明',
    subject: '退款处理说明：订单 {订单号}',
    html: body(
      '{对方称呼}，您好：',
      '您的订单 {订单号} 退款申请已审核通过，退款金额 {金额} 将原路退回，预计 {到账时间} 内到账。',
      '如超过时间仍未到账，请回复本邮件，我们会第一时间帮您跟进。给您带来不便，敬请谅解。',
      SIGN
    )
  },
  {
    id: 'cs-fixed',
    category: '客服与售后',
    name: '问题已修复',
    subject: '已修复：{问题简述}',
    html: body(
      '{对方称呼}，您好：',
      '您之前反馈的「{问题简述}」已在 {版本号} 中修复，更新后即可正常使用。',
      '感谢您的耐心和详细反馈，帮助我们把产品做得更好。如还有任何问题，欢迎随时联系。',
      SIGN
    )
  },
  {
    id: 'cs-feedback',
    category: '客服与售后',
    name: '感谢反馈',
    subject: '感谢您的建议',
    html: body(
      '{对方称呼}，您好：',
      '感谢您提出的建议！我们已记录并转交产品团队评估，后续如有进展会及时通知您。',
      SIGN
    )
  },

  // ---------- 个人与生活 ----------
  {
    id: 'life-invite',
    category: '个人与生活',
    name: '邀约',
    subject: '{活动}，一起吗？',
    html: body(
      '{对方称呼}：',
      '好久不见！{活动时间} 打算 {活动内容}，地点在 {地点}，想约你一起。',
      '有空的话回我一声，时间也可以再商量～',
      '{我的名字}'
    )
  },
  {
    id: 'life-wishes',
    category: '个人与生活',
    name: '节日祝福',
    subject: '{节日}快乐！',
    html: body('{对方称呼}：', '{节日}快乐！祝你和家人身体健康、万事顺意。', '有空常联系～', '{我的名字}\n{日期}')
  },
  {
    id: 'life-leave',
    category: '个人与生活',
    name: '请假',
    subject: '请假申请 —— {我的名字}',
    html: body(
      '{对方称呼}，您好：',
      '因 {请假原因}，我想申请于 {开始日期} 至 {结束日期} 请假，共 {天数} 天。',
      '请假期间手头工作已安排 {代理人} 跟进，紧急事项可电话联系我。望批准，谢谢！',
      SIGN
    )
  },
  {
    id: 'life-birthday',
    category: '个人与生活',
    name: '生日祝福',
    subject: '生日快乐！',
    html: body('{对方称呼}：', '生日快乐！愿新的一岁平安喜乐，所求皆如愿。', '{我的名字}')
  },

  // ---------- Business English ----------
  {
    id: 'en-followup',
    category: 'Business English',
    name: 'Follow-up',
    subject: 'Following up on {Topic}',
    html: body(
      'Hi {Recipient},',
      'I hope you’re doing well. I wanted to follow up on {Topic} that we discussed on {Previous Date}.',
      'Could you let me know if there are any updates on your side? Happy to provide anything else you need.',
      SIGN_EN
    )
  },
  {
    id: 'en-meeting',
    category: 'Business English',
    name: 'Meeting request',
    subject: 'Meeting request: {Topic}',
    html: body(
      'Hi {Recipient},',
      'Would you be available for a {Duration} call to discuss {Topic}? I’m free on {Option 1} or {Option 2}, but happy to work around your schedule.',
      'Looking forward to speaking with you.',
      SIGN_EN
    )
  },
  {
    id: 'en-decline',
    category: 'Business English',
    name: 'Polite decline',
    subject: 'Re: {Topic}',
    html: body(
      'Hi {Recipient},',
      'Thank you for thinking of us. After careful consideration, we’ve decided not to move forward at this time, as it doesn’t align with our current priorities.',
      'I really appreciate the time you put into this and hope we can find a better fit in the future.',
      SIGN_EN
    )
  },
  {
    id: 'en-thanks',
    category: 'Business English',
    name: 'Thank-you',
    subject: 'Thank you',
    html: body(
      'Hi {Recipient},',
      'Thank you so much for {Reason}. It made a real difference to {Outcome}.',
      'Please let me know if there’s ever anything I can do in return.',
      SIGN_EN
    )
  }
]
