import type { FinancePdfCheck } from '@shared/types'
import { api } from '../../lib/api'
import { IconCheck, IconFileText } from '../../components/icons'

const money = (n: number, cur?: string | null) => {
  const v = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return !cur || cur === 'CNY' ? `¥${v}` : `${cur} ${v}`
}

/** 款项详情里的一行：「PDF 核对：一致」或「PDF 核对：金额不符 ¥x」（附件正文抽到的发票金额 / 发票号 vs 记录） */
export function PdfCheckLine(props: { check: FinancePdfCheck; amount: number | null; currency: string; invoiceNo?: string | null }) {
  const c = props.check
  const amountBad = c.amount != null && props.amount != null && Math.abs(c.amount - props.amount) >= 0.01
  const noBad = !!c.invoiceNo && !!props.invoiceNo && c.invoiceNo.toUpperCase().replace(/[^A-Z0-9]/g, '') !== props.invoiceNo.toUpperCase().replace(/[^A-Z0-9]/g, '')
  // 记录可能在核对之后被手动改过：按当前金额 / 发票号重新判断，与存下的结论不同时用现算的说明
  const matched = !amountBad && !noBad
  const head = matched ? '一致' : amountBad ? `金额不符 ${money(c.amount!, props.currency)}` : `发票号不符 ${c.invoiceNo}`
  const note = matched === c.matched ? c.note : matched ? `与 PDF 一致（PDF 金额 ${c.amount != null ? money(c.amount, props.currency) : '—'}${c.invoiceNo ? ` · 发票号 ${c.invoiceNo}` : ''}）` : `PDF 金额 ${c.amount != null ? money(c.amount, props.currency) : '—'}${c.invoiceNo ? ` · 发票号 ${c.invoiceNo}` : ''}`
  return (
    <section>
      <div className="caps mb-1.5" style={{ color: 'var(--faint)' }}>PDF 核对</div>
      <div
        className="flex items-start gap-2 px-2.5 py-2 rounded-[var(--r-sm)] text-xs"
        style={matched ? { background: 'var(--ok-soft)', color: 'var(--ok-ink)' } : { background: 'var(--danger-soft)', color: 'var(--danger-ink)' }}
      >
        <span className="mt-[1px] shrink-0">{matched ? <IconCheck width={12} height={12} /> : '!'}</span>
        <span className="flex-1 min-w-0">
          <span className="font-medium">PDF 核对：{head}</span>
          {note && <span className="block mt-0.5 text-2xs" style={{ opacity: 0.85 }}>{note}</span>}
        </span>
        {c.attachmentId && (
          <button onClick={() => void api.attachOpen(c.attachmentId!)} className="shrink-0 inline-flex items-center gap-1 text-2xs underline underline-offset-2" title="打开发票 PDF">
            <IconFileText width={11} height={11} /> PDF
          </button>
        )}
      </div>
    </section>
  )
}
