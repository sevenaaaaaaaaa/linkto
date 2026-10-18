import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { IconCloud } from '../../components/icons'
import type { AttachmentCloudCopy } from '@shared/attachments'
import { cloudLabel } from './model'

type Status = { cached: boolean; releasedAt: number | null; cloud: AttachmentCloudCopy[] }

/**
 * 阅读窗附件卡上的一行状态：「已在 Proton Drive」（点按在 Finder 中显示 / 打开云端位置）
 * 或「本地已释放 · 点开时重新下载」。没有状态时不渲染，附件卡保持原样。
 */
export function AttachmentBadge(props: { id: string }) {
  const [st, setSt] = useState<Status | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => void api.attachStatus([props.id]).then(r => alive && setSt(r[props.id] ?? null)).catch(() => {})
    load()
    const off = api.onEvent(ev => {
      if ((ev as { type: string }).type === 'attachments-changed') load()
    })
    return () => {
      alive = false
      off()
    }
  }, [props.id])
  if (!st) return null
  if (st.cloud.length) {
    const first = st.cloud[0]
    return (
      <span
        role="link"
        tabIndex={0}
        title={`${st.cloud.map(c => `${c.driveName}：${c.path}`).join('\n')}\n点按${first.kind === 'local' ? '在 Finder 中显示' : '打开云端位置'}`}
        onClick={e => {
          e.stopPropagation()
          void api.attachReveal(props.id, first.driveId)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.stopPropagation()
            void api.attachReveal(props.id, first.driveId)
          }
        }}
        className="mt-0.5 flex items-center gap-1 text-2xs max-w-[180px] truncate hover:underline"
        style={{ color: 'var(--info-ink)' }}
      >
        <IconCloud width={10} height={10} /> {cloudLabel(st.cloud)}
      </span>
    )
  }
  if (!st.cached && st.releasedAt) {
    return (
      <span className="mt-0.5 block text-2xs" style={{ color: 'var(--faint)' }} title="本地缓存已释放以节省空间，点开或保存时自动重新下载">
        本地已释放 · 点开时重新下载
      </span>
    )
  }
  return null
}
