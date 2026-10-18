import { BrowserWindow, dialog, ipcMain, app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LinkToApi } from '@shared/ipc'
import type { FinanceData } from '@shared/types'
import { FINANCE_KIND_LABEL, FINANCE_STATUS_LABEL, itemAt } from '@shared/finance'
import type { FinanceService } from './service'

type Handler<K extends keyof LinkToApi> = (...args: Parameters<LinkToApi[K]>) => Awaited<ReturnType<LinkToApi[K]>> | ReturnType<LinkToApi[K]>

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const ymd = (t: number | null | undefined) => {
  if (!t) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 款项 → CSV（UTF-8 BOM，Excel / Numbers 直接打开不乱码） */
export function financeCsv(rows: { title: string; dueAt: number | null; createdAt: number; data: FinanceData }[]): string {
  const head = ['日期', '对方', '标题', '类型', '方向', '金额', '币种', '状态', '应付日', '付款日', '发票号', 'PO', '合同号', '订单号', '对账组', '分类', '备注', '关联邮件数']
  const lines = rows
    .sort((a, b) => itemAt(a) - itemAt(b))
    .map(r => {
      const d = r.data
      return [
        ymd(itemAt(r)),
        d.counterparty,
        r.title,
        FINANCE_KIND_LABEL[d.kind] ?? d.kind,
        d.direction === 'in' ? '收入 / 应收' : '支出 / 应付',
        d.amount ?? '',
        d.currency,
        FINANCE_STATUS_LABEL[d.status] ?? d.status,
        ymd(r.dueAt),
        ymd(d.paidAt),
        d.invoiceNo ?? '',
        d.poNo ?? '',
        d.contractNo ?? '',
        d.orderNo ?? '',
        d.matchId ?? '',
        d.category ?? '',
        d.notes ?? '',
        d.messageIds?.length ?? 0
      ]
        .map(csvCell)
        .join(',')
    })
  return '﻿' + [head.join(','), ...lines].join('\r\n') + '\r\n'
}

/** 财务中心 IPC（api:finance*），与 registerIpc 并列注册，不改动既有处理器 */
export function registerFinanceIpc(finance: FinanceService) {
  const handlers: { [K in keyof LinkToApi as K extends `finance${string}` ? K : never]: Handler<K> } = {
    financeList: () => finance.list(),
    financeCreate: input => finance.create(input ?? {}),
    financeUpdate: (id, patch) => finance.update(id, patch ?? {}),
    financeDelete: id => finance.remove(id),
    financeMarkPaid: (id, paid) => finance.markPaid(id, paid !== false),
    financeMakeTodo: id => finance.makeTodo(id),
    financeFromMessage: messageId => finance.fromMessage(messageId),
    financeMessages: ids => finance.messages(Array.isArray(ids) ? ids : []),
    financePair: ids => finance.pair(Array.isArray(ids) ? ids : []),
    financeUnpair: ids => finance.unpair(Array.isArray(ids) ? ids : []),
    financeScan: days => finance.scan(Number(days) || 90),
    financeExportCsv: async () => ({ ok: false })
  }

  for (const [method, handler] of Object.entries(handlers)) {
    if (method === 'financeExportCsv') continue
    ipcMain.handle(`api:${method}`, async (_e, ...args) => {
      try {
        return await (handler as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err)
        throw err
      }
    })
  }

  ipcMain.handle('api:financeExportCsv', async (e, opts: Parameters<LinkToApi['financeExportCsv']>[0]) => {
    try {
      const o = opts ?? {}
      const rows = finance.rows(false).filter(r => {
        if (o.ids?.length) return o.ids.includes(r.id)
        const at = itemAt(r)
        if (o.counterparty && r.data.counterparty !== o.counterparty) return false
        if (o.from && at < o.from) return false
        if (o.to && at > o.to) return false
        return true
      })
      if (!rows.length) return { ok: false, error: '没有符合条件的款项' }
      const win = BrowserWindow.fromWebContents(e.sender)
      const name = `${(o.name || o.counterparty || '财务').replace(/[\\/:*?"<>|]/g, '_')}-${ymd(Date.now())}.csv`
      const opt = { title: '导出 CSV', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'CSV', extensions: ['csv'] }] }
      const res = win ? await dialog.showSaveDialog(win, opt) : await dialog.showSaveDialog(opt)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      writeFileSync(res.filePath, financeCsv(rows), 'utf8')
      return { ok: true, path: res.filePath, count: rows.length }
    } catch (err) {
      console.error('[ipc:financeExportCsv]', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
