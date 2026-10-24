// 内置签名模板：产物进入邮件正文，必须全内联样式 + 邮件安全字体栈（不依赖 app token / 外部资源）
export interface SignatureTemplate {
  id: string
  name: string
  desc: string
  html: string
}

const FONT = `-apple-system,'PingFang SC','Hiragino Sans GB','Segoe UI','Microsoft YaHei',sans-serif`
const INK = '#1f2937'
const MUTED = '#6b7280'
const ACCENT = '#2563eb'

const wrap = (inner: string) => `<div style="font-family:${FONT};color:${INK};font-size:13px;line-height:1.6">${inner}</div>`

export const SIGNATURE_TEMPLATES: SignatureTemplate[] = [
  {
    id: 'biz-cn',
    name: '中文商务',
    desc: '姓名职位 + 完整联系方式，顶部品牌色分隔线',
    html: wrap(
      `<div style="border-top:3px solid ${ACCENT};padding-top:10px">
  <div style="font-size:15px;font-weight:600">林一</div>
  <div style="color:${MUTED};margin:2px 0 8px">产品经理 · 某某科技有限公司</div>
  <div style="font-size:12px;color:${MUTED}">
    <span style="color:${INK}">手机</span> 138-0000-0000&nbsp;&nbsp;|&nbsp;&nbsp;<span style="color:${INK}">邮箱</span> linyi@example.com<br/>
    <span style="color:${INK}">地址</span> 上海市浦东新区某某路 88 号
  </div>
</div>`
    )
  },
  {
    id: 'minimal-line',
    name: '极简单行',
    desc: '一行搞定，适合快节奏沟通',
    html: wrap(
      `<div style="color:${MUTED};font-size:12px">
  <span style="color:${INK};font-weight:600;font-size:13px">林一</span>
  &nbsp;·&nbsp;产品设计&nbsp;&nbsp;|&nbsp;&nbsp;138-0000-0000&nbsp;&nbsp;|&nbsp;&nbsp;linyi@example.com
</div>`
    )
  },
  {
    id: 'classic-border',
    name: '左侧竖线经典',
    desc: '竖线分隔的姓名块 + 联系方式块',
    html: wrap(
      `<table cellpadding="0" cellspacing="0"><tr>
  <td style="border-left:3px solid ${ACCENT};padding:2px 12px 2px 10px">
    <div style="font-size:15px;font-weight:600">林一</div>
    <div style="color:${MUTED};font-size:12px">产品经理</div>
  </td>
  <td style="padding:2px 0 2px 12px;color:${MUTED};font-size:12px;border-left:1px solid #e5e7eb">
    某某科技有限公司<br/>138-0000-0000 · linyi@example.com<br/>www.example.com
  </td>
</tr></table>`
    )
  },
  {
    id: 'bilingual',
    name: '中英双语',
    desc: '中文在上、英文在下，适合涉外沟通',
    html: wrap(
      `<div>
  <div style="font-size:15px;font-weight:600">林一 <span style="font-weight:400;color:${MUTED};font-size:12px">/ Yi Lin</span></div>
  <div style="color:${MUTED};font-size:12px;margin:2px 0">产品经理 · Product Manager</div>
  <div style="color:${MUTED};font-size:12px">某某科技有限公司 · 138-0000-0000 · linyi@example.com</div>
  <div style="border-top:1px solid #e5e7eb;margin-top:8px;padding-top:6px;color:#9ca3af;font-size:11px">
    Yi Lin · Product Manager · Example Tech · +86 138-0000-0000
  </div>
</div>`
    )
  },
  {
    id: 'social-links',
    name: '社交链接型',
    desc: '姓名 + 网站/博客/GitHub 链接行',
    html: wrap(
      `<div>
  <div style="font-size:15px;font-weight:600;margin-bottom:2px">林一</div>
  <div style="color:${MUTED};font-size:12px;margin-bottom:6px">独立开发者</div>
  <div style="font-size:12px">
    <a href="https://example.com" style="color:${ACCENT};text-decoration:none">网站</a>
    &nbsp;·&nbsp;<a href="https://blog.example.com" style="color:${ACCENT};text-decoration:none">博客</a>
    &nbsp;·&nbsp;<a href="https://github.com/username" style="color:${ACCENT};text-decoration:none">GitHub</a>
  </div>
</div>`
    )
  },
  {
    id: 'team',
    name: '团队署名',
    desc: '以团队/部门名义落款，含地址与声明',
    html: wrap(
      `<div style="border-top:1px solid #e5e7eb;padding-top:8px">
  <div style="font-size:13px;font-weight:600">某某科技 · 客户服务团队</div>
  <div style="color:${MUTED};font-size:12px;margin:2px 0 4px">service@example.com · 400-000-0000</div>
  <div style="color:#9ca3af;font-size:11px">上海市浦东新区某某路 88 号 · workdays 9:00-18:00</div>
</div>`
    )
  },
  {
    id: 'serif-hand',
    name: '手写感简洁',
    desc: '衬线字体的个人化落款',
    html: wrap(
      `<div style="font-family:Georgia,'Songti SC','SimSun',serif">
  <div style="font-size:17px">林一</div>
  <div style="color:${MUTED};font-size:12px;margin-top:2px">写代码，也写信。</div>
  <div style="color:${MUTED};font-size:12px;margin-top:4px">linyi@example.com</div>
</div>`
    )
  },
  {
    id: 'legal-note',
    name: '商务 + 保密声明',
    desc: '完整签名下带保密免责小字',
    html: wrap(
      `<div style="border-top:3px solid ${ACCENT};padding-top:10px">
  <div style="font-size:15px;font-weight:600">林一</div>
  <div style="color:${MUTED};font-size:12px;margin:2px 0 6px">法务经理 · 某某科技有限公司 · 138-0000-0000</div>
  <div style="color:#9ca3af;font-size:11px;line-height:1.5">
    本邮件及其附件含有仅供收件人使用的信息。若您误收此邮件，请立即删除并告知发件人；未经许可，不得复制、转发或披露其内容。
  </div>
</div>`
    )
  }
]
