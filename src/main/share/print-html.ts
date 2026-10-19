import { escapeHtml } from './html'

/**
 * 打印版 HTML（PDF / 长图共用）：头部信息 + 正文 + 附件清单。
 * - 正文先在主进程消毒（sanitizeHtml），再放进 <template>（惰性，不加载图片不跑脚本），
 *   渲染窗口里用 executeJavaScript 挂进各自的 Shadow DOM，邮件自带的 CSS 不会污染头部排版；
 * - CSP 不给任何脚本来源，远程图片按设置放行。
 * 纯函数，可单测。
 */

export interface PrintMail {
  subject: string
  from: string
  to: string
  cc?: string
  dateText: string
  /** 已消毒的正文 HTML */
  html: string
  attachments: { name: string; size: number }[]
  gist?: string | null
}

export interface PrintOptions {
  allowRemote: boolean
  attachmentList: boolean
  mode: 'pdf' | 'png'
  /** 长图宽度（CSS 像素） */
  width?: number
  /** 页脚 / 图片底部的说明 */
  footer?: string
}

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

export function printCsp(allowRemote: boolean): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${allowRemote ? 'https: http:' : ''}; font-src data:; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`.replace(/\s+;/g, ';')
}

export function buildPrintHtml(mails: PrintMail[], opts: PrintOptions): string {
  const png = opts.mode === 'png'
  const w = Math.max(320, Math.min(1600, Math.round(opts.width ?? 750)))
  const sections = mails
    .map((m, i) => {
      const atts =
        opts.attachmentList && m.attachments.length
          ? `<div class="lt-atts"><div class="lt-label">附件（${m.attachments.length}）</div><ul>${m.attachments
              .map(a => `<li>${escapeHtml(a.name)}<span>${fmtSize(a.size)}</span></li>`)
              .join('')}</ul></div>`
          : ''
      return `<section class="lt-mail${i > 0 ? ' lt-break' : ''}">
  <header class="lt-head">
    <h1>${escapeHtml(m.subject || '（无主题）')}</h1>
    <table class="lt-meta">
      <tr><th>发件人</th><td>${escapeHtml(m.from)}</td></tr>
      <tr><th>收件人</th><td>${escapeHtml(m.to || '—')}</td></tr>
      ${m.cc ? `<tr><th>抄送</th><td>${escapeHtml(m.cc)}</td></tr>` : ''}
      <tr><th>时间</th><td>${escapeHtml(m.dateText)}</td></tr>
    </table>
    ${m.gist ? `<div class="lt-gist"><b>AI 要点</b>　${escapeHtml(m.gist)}</div>` : ''}
  </header>
  <div class="lt-body" data-mail="${i}"></div>
  <template data-mail="${i}">${m.html}</template>
  ${atts}
</section>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${printCsp(opts.allowRemote)}">
<meta name="viewport" content="width=${png ? w : 'device-width'}">
<title>${escapeHtml(mails.length === 1 ? mails[0].subject || '邮件' : `${mails.length} 封邮件`)}</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #ffffff; color: #1f2329; }
  html { scrollbar-width: none; }
  ::-webkit-scrollbar { display: none; width: 0; height: 0; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${png ? `body { width: ${w}px; } #lt-root { padding: 28px 28px 20px; box-sizing: border-box; width: ${w}px; overflow: hidden; }` : '#lt-root { padding: 0; }'}
  .lt-mail { margin: 0 0 28px; }
  .lt-break { ${png ? 'margin-top: 36px; padding-top: 28px; border-top: 1px dashed #c9cdd4;' : 'break-before: page;'} }
  .lt-head { border-bottom: 1px solid #e5e6eb; padding-bottom: 12px; margin-bottom: 16px; }
  .lt-head h1 { font-size: ${png ? 22 : 20}px; line-height: 1.35; margin: 0 0 10px; font-weight: 600; word-break: break-word; }
  .lt-meta { border-collapse: collapse; font-size: 12.5px; color: #4e5969; }
  .lt-meta th { text-align: left; font-weight: 500; color: #86909c; padding: 1px 12px 1px 0; white-space: nowrap; vertical-align: top; }
  .lt-meta td { padding: 1px 0; word-break: break-all; }
  .lt-gist { margin-top: 10px; padding: 8px 10px; border-radius: 6px; background: #f2f3f5; font-size: 13px; }
  .lt-body { overflow-wrap: anywhere; }
  .lt-atts { margin-top: 18px; padding-top: 10px; border-top: 1px solid #e5e6eb; font-size: 12.5px; color: #4e5969; break-inside: avoid; }
  .lt-label { font-weight: 600; margin-bottom: 4px; color: #1f2329; }
  .lt-atts ul { margin: 0; padding-left: 18px; }
  .lt-atts li span { color: #86909c; margin-left: 8px; }
  #lt-trunc { display: none; margin: 0 28px 24px; padding: 10px 12px; border-radius: 6px; background: #fff7e8; color: #8a5300; font-size: 13px; text-align: center; }
  #lt-foot { ${png ? 'display: block;' : 'display: none;'} margin: 4px 28px 22px; font-size: 11px; color: #a9aeb8; text-align: right; }
  @page { size: A4; margin: 16mm 14mm; }
</style></head>
<body><div id="lt-root">
${sections}
</div><div id="lt-trunc">内容过长，长图已截断；完整内容请导出 PDF</div><div id="lt-foot">${escapeHtml(opts.footer ?? '')}</div></body></html>`
}

/**
 * 渲染窗口里执行：把 <template> 挂进 Shadow DOM，并等图片加载完（最多 timeoutMs）。
 * 返回页面总高度（CSS 像素）。
 */
export function mountScript(timeoutMs = 8000): string {
  return `(async () => {
  const shadowCss = 'img{max-width:100%;height:auto} table{max-width:100%} pre{white-space:pre-wrap} :host{display:block;color:#1f2329}';
  for (const tpl of document.querySelectorAll('template[data-mail]')) {
    const host = document.querySelector('.lt-body[data-mail="' + tpl.dataset.mail + '"]');
    if (!host) continue;
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = shadowCss;
    root.appendChild(st);
    root.appendChild(tpl.content.cloneNode(true));
  }
  const imgs = [];
  for (const h of document.querySelectorAll('.lt-body')) if (h.shadowRoot) imgs.push(...h.shadowRoot.querySelectorAll('img'));
  await Promise.race([
    Promise.all(imgs.map(img => img.complete ? null : new Promise(r => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); }))),
    new Promise(r => setTimeout(r, ${Math.max(500, timeoutMs)}))
  ]);
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return Math.ceil(document.documentElement.scrollHeight);
})()`
}

/** 长图超过上限：正文区域裁到 maxHeight，显示截断提示；返回新的总高度 */
export function truncateScript(maxHeight: number): string {
  return `(async () => {
  const root = document.getElementById('lt-root');
  const note = document.getElementById('lt-trunc');
  if (document.documentElement.scrollHeight <= ${maxHeight}) return { height: Math.ceil(document.documentElement.scrollHeight), truncated: false };
  note.style.display = 'block';
  const extra = document.documentElement.scrollHeight - root.offsetHeight;
  root.style.maxHeight = Math.max(400, ${maxHeight} - extra) + 'px';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { height: Math.ceil(document.documentElement.scrollHeight), truncated: true };
})()`
}
