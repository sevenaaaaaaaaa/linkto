import { useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import type { ArchiveJobStatus, AttachmentCategory, AttachmentCloudCopy } from '@shared/attachments'
import { attachmentCategoryLabel } from '@shared/attachments'

export { attachmentCategoryLabel }

/** 字节数：B / KB / MB / GB（附件中心需要到 GB） */
export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function fmtDay(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('zh-CN', sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' })
}

/** 文件类型小标签（卡片缩略图占位用：PDF / DOCX / XLSX …） */
export function extBadge(ext: string, category: AttachmentCategory): string {
  if (ext) return ext.slice(0, 4).toUpperCase()
  return attachmentCategoryLabel(category).slice(0, 2)
}

export function cloudLabel(c: AttachmentCloudCopy[]): string {
  if (!c.length) return ''
  const names = [...new Set(c.map(x => x.driveName))]
  return names.length > 1 ? `已在 ${names[0]} 等 ${names.length} 处` : `已在 ${names[0]}`
}

export const RELEASE_REASON: Record<string, string> = {
  old: '超过保留天数',
  archived: '已归档到网盘',
  quota: '超出总量上限',
  manual: '手动选择'
}

export const VIA_LABEL: Record<string, string> = {
  eml: '本地原文',
  imap: '邮件服务器',
  cloud: '网盘副本'
}

/** 订阅附件中心事件：索引变化（防抖）与归档队列进度 */
export function useAttachmentEvents(onChanged: () => void, onJob?: (s: ArchiveJobStatus | null) => void) {
  const changedRef = useRef(onChanged)
  const jobRef = useRef(onJob)
  changedRef.current = onChanged
  jobRef.current = onJob
  useEffect(() => {
    let timer = 0
    const off = api.onEvent(ev => {
      const e = ev as { type: string; status?: ArchiveJobStatus | null }
      if (e.type === 'attachments-changed') {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => changedRef.current(), 300)
      }
      if (e.type === 'attachments-job') jobRef.current?.(e.status ?? null)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [])
}
