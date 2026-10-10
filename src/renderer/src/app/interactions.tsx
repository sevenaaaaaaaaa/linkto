import { useEffect, useRef, useState } from 'react'
import { useMail } from '../stores/mail'
import { api, displayName } from '../lib/api'
import { subjectIsAuth } from '../lib/auth-detect'
import { IconKey, IconPlug, IconSearch, IconArchive, IconTrash, IconClose } from '../components/icons'
import type { MessageSummary } from '@shared/types'

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

function MiniAvatar({ name }: { name: string }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?'
  return (
    <div
      className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-medium shrink-0"
      style={{ background: `hsl(${(name.charCodeAt(0) * 7) % 360} 55% 55%)`, color: '#fff' }}
    >
      {letter}
    </div>
  )
}

// ============================================================
// 玻璃透镜 · 按住 ⌥（Alt）：一枚真折射的液体玻璃透镜悬浮于指针上方，
// 划过列表即透出该邮件的完整速览；透镜不拦截点击，松开点击即打开。
// ============================================================
export function LensLayer() {
  const [active, setActive] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [msg, setMsg] = useState<MessageSummary | null>(null)
  const activeRef = useRef(false)

  useEffect(() => {
    let raf = 0
    const pick = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest?.('[data-lens-id]') as HTMLElement | null
      if (!el?.dataset.lensId) return setMsg(null)
      setMsg(useMail.getState().messages.find(m => m.id === el.dataset.lensId) ?? null)
    }
    const onMove = (e: PointerEvent) => {
      if (!activeRef.current) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        setPos({ x: e.clientX, y: e.clientY })
        pick(e.clientX, e.clientY)
      })
    }
    const on = () => {
      activeRef.current = true
      setActive(true)
    }
    const off = () => {
      activeRef.current = false
      setActive(false)
      setMsg(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !e.repeat && !activeRef.current) on()
      if (e.key === 'Escape' && activeRef.current) off()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') off()
    }
    const onBlur = () => off()
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('blur', onBlur)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  if (!active) return null
  const W = 196
  const left = Math.min(Math.max(pos.x - W / 2, 10), window.innerWidth - W - 10)
  const top = Math.max(pos.y - W - 34, 12)

  return (
    <div
      className="fixed z-[60] pointer-events-none select-none rounded-full liquid-glass pop-in overflow-hidden flex flex-col items-center justify-center text-center"
      style={{ width: W, height: W, left, top, padding: '0 18px' }}
    >
      {msg ? (
        <div className="flex flex-col items-center gap-1.5 w-full fade-in">
          <MiniAvatar name={displayName(msg.from) || '?'} />
          <div className="w-full truncate text-[12.5px] font-semibold" style={{ color: 'var(--fg)' }}>
            {displayName(msg.from) || '（未知发件人）'}
          </div>
          <div
            className="w-full text-[12px] leading-snug line-clamp-2"
            style={{ color: 'var(--fg)', opacity: 0.85 }}
          >
            {msg.subject || '（无主题）'}
          </div>
          <div className="w-full text-[11px] leading-snug line-clamp-2" style={{ color: 'var(--faint)' }}>
            {msg.snippet}
          </div>
          <div className="flex items-center gap-1.5">
            {msg.unread && <span className="w-[6px] h-[6px] rounded-full" style={{ background: 'var(--accent)' }} />}
            {subjectIsAuth(msg.subject) && (
              <span className="inline-flex" style={{ color: 'var(--accent-strong)' }}><IconKey width={11} height={11} /></span>
            )}
            <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--faint)' }}>
              {new Date(msg.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--faint)' }}>
          玻璃透镜
          <br />
          划过列表速览邮件
        </div>
      )}
    </div>
  )
}

// ============================================================
// 波纹批量 · Ripple：每一次单发操作（归档/删除）都会向同类邮件
// 扩散一圈波纹，把「还有 N 封一起处理？」从隐藏功能变成自然涌现。
// ============================================================
interface RippleSuggestion {
  action: 'archive' | 'trash'
  ids: string[]
  count: number
  why: string
}

export function RipplePanel() {
  const [sug, setSug] = useState<RippleSuggestion | null>(null)
  const timer = useRef(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onRipple = (ev: Event) => {
      const { ids, action } = (ev as CustomEvent<{ ids: string[]; action: 'archive' | 'trash' }>).detail
      const messages = useMail.getState().messages
      const done = new Set(ids)
      const anchor = messages.find(m => ids.includes(m.id))
      if (!anchor) return
      // 优先同发件人，不足时退化为同 AI 分类（订阅 / 噪声）
      let rel = messages.filter(m => !done.has(m.id) && m.from?.address && m.from.address === anchor.from?.address)
      let why = `同样来自 ${displayName(anchor.from)}`
      if (!rel.length && (anchor.category === 'newsletter' || anchor.category === 'noise')) {
        rel = messages.filter(m => !done.has(m.id) && m.category === anchor.category)
        why = anchor.category === 'newsletter' ? '同属订阅类邮件' : '同属噪声类邮件'
      }
      if (!rel.length) return setSug(null)
      setSug({ action, ids: rel.slice(0, 200).map(m => m.id), count: rel.length, why })
      clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setSug(null), 9000)
    }
    window.addEventListener('ms:ripple', onRipple)
    return () => {
      window.removeEventListener('ms:ripple', onRipple)
      clearTimeout(timer.current)
    }
  }, [])

  // 点面板外忽略（面板不自动抢焦点，9s 后自动消散）
  useEffect(() => {
    if (!sug) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setSug(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [sug])

  const run = async () => {
    const s = sug
    if (!s) return
    setSug(null)
    if (s.action === 'archive') await api.moveMessages(s.ids, 'archive')
    else await api.deleteMessages(s.ids)
    toast(`波纹批量：已${s.action === 'archive' ? '归档' : '删除'} ${s.count} 封${s.action === 'archive' ? '' : ''}`)
    void useMail.getState().loadMessages()
  }

  if (!sug) return null
  return (
    <div ref={ref} className="fixed left-6 bottom-6 z-40 w-[330px] liquid-glass pop-in rounded-[var(--r-md)] p-3.5">
      <div className="flex items-start gap-3">
        <span className="relative flex items-center justify-center w-8 h-8 shrink-0 rounded-full" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          <span className="ripple-ring" />
          <span className="ripple-ring" style={{ animationDelay: '.7s' }} />
          {sug.action === 'archive' ? <IconArchive width={15} height={15} /> : <IconTrash width={15} height={15} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>
            波纹 · {sug.why}
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: 'var(--muted)' }}>
            还有 <b style={{ color: 'var(--accent-strong)' }}>{sug.count}</b> 封同类邮件，一起{sug.action === 'archive' ? '归档' : '删除'}？
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void run()}
              className="btn-liquid text-[12px] font-medium px-3 py-1.5 rounded-full"
            >
              一起处理 →
            </button>
            <button
              onClick={() => setSug(null)}
              className="text-[12px] px-2.5 py-1.5 rounded-full hover:bg-[var(--hover)]"
              style={{ color: 'var(--muted)' }}
            >
              忽略
            </button>
          </div>
        </div>
        <button onClick={() => setSug(null)} className="p-1 rounded hover:bg-[var(--hover)] shrink-0" style={{ color: 'var(--faint)' }}>
          <IconClose width={12} height={12} />
        </button>
      </div>
    </div>
  )
}

// ============================================================
// 液态投放井 · Drop Well：右下角常驻一颗会呼吸的液态玻璃圆井。
// 拖住邮件靠近时井口张开泛光，投放即弹出连接器速投菜单。
// ============================================================
const DND_TYPE = 'text/ms-mail-ids'

interface WellMenuItem {
  instanceId: string
  name: string
  color: string
  actionId: string
  actionName: string
}

export function DropWell(props: { bottom: number }) {
  const [hot, setHot] = useState(false)
  const [pending, setPending] = useState<string[] | null>(null)
  const [menu, setMenu] = useState<WellMenuItem[]>([])
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const hasPayload = (e: DragEvent) => !!e.dataTransfer && [...(e.dataTransfer.types ?? [])].includes(DND_TYPE)
    const onOver = (e: DragEvent) => {
      if (!hasPayload(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setHot(true)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasPayload(e)) return
      e.preventDefault()
      setHot(false)
      const raw = e.dataTransfer?.getData(DND_TYPE) ?? ''
      const ids = raw.split(',').filter(Boolean)
      if (!ids.length) return
      setPending(ids)
    }
    const onDragEnd = () => setHot(false)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [])

  // 投放后加载已连接连接器的可用动作
  useEffect(() => {
    if (!pending) return
    void (async () => {
      const [instances, manifests] = await Promise.all([api.listConnectorInstances(), api.listConnectorManifests()])
      const items: WellMenuItem[] = instances
        .filter(i => i.enabled)
        .map(i => {
          const m = manifests.find(x => x.id === i.manifestId)
          return (m?.actions ?? []).map(a => ({
            instanceId: i.id,
            name: m?.name ?? i.manifestId,
            color: m?.color ?? 'var(--accent)',
            actionId: a.id,
            actionName: a.name
          }))
        })
        .flat()
      if (!items.length) {
        toast('还没有已连接的连接器，去 设置 → 集成 添加')
        setPending(null)
        return
      }
      setMenu(items)
    })()
  }, [pending])

  // 菜单点外关闭
  useEffect(() => {
    if (!menu.length) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenu([])
        setPending(null)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  const run = async (item: WellMenuItem) => {
    const ids = pending ?? []
    setMenu([])
    setPending(null)
    const cap = ids.slice(0, 20)
    let okCount = 0
    let lastErr = ''
    for (const id of cap) {
      const res = await api.runConnectorAction(item.instanceId, item.actionId, {}, id)
      if (res.ok) okCount++
      else lastErr = res.error ?? '未知错误'
    }
    toast(
      okCount === cap.length
        ? `已速投到「${item.name} · ${item.actionName}」${cap.length > 1 ? `（${cap.length} 封）` : ''}`
        : `速投失败：${lastErr}`
    )
  }

  return (
    <div ref={menuRef} className="fixed right-6 z-40" style={{ bottom: props.bottom }}>
      <div
        title="液态投放井：把邮件拖进来，一秒速投到连接器"
        className={`drop-well relative w-14 h-14 rounded-full liquid-glass flex items-center justify-center cursor-grab active:cursor-grabbing transition-all duration-300 ${hot ? 'drop-well-hot' : ''}`}
      >
        {hot && <span className="ripple-ring" />}
        <IconPlug width={22} height={22} style={{ color: hot ? 'var(--accent)' : 'var(--muted)' }} />
      </div>
      {menu.length > 0 && pending && (
        <div className="absolute bottom-[68px] right-0 w-[264px] max-h-[320px] overflow-y-auto liquid-glass pop-in rounded-[var(--r-md)] p-1.5">
          <div
            className="px-2 pt-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[.08em]"
            style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}
          >
            速投 {pending.length} 封到…
          </div>
          {menu.map((it, i) => (
            <button
              key={`${it.instanceId}-${it.actionId}-${i}`}
              onClick={() => void run(it)}
              className="w-full text-left px-2.5 py-2 rounded-[10px] text-[12.5px] hover:bg-[var(--hover)] inline-flex items-center gap-2"
              style={{ color: 'var(--fg)' }}
            >
              <i className="w-2 h-2 rounded-full shrink-0" style={{ background: it.color }} />
              <span className="truncate font-medium">{it.name}</span>
              <span className="truncate" style={{ color: 'var(--faint)' }}>· {it.actionName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// 按住即搜 · Push-to-Search：长按空格进入声呐态，玻璃泛起涟漪，
// 直接打字即全库检索；松开空格立即跳转命中结果。零点击搜索。
// ============================================================
export function SonarBar() {
  const [active, setActive] = useState(false)
  const [q, setQ] = useState('')
  const qRef = useRef('')
  const inputRef = useRef<HTMLInputElement>(null)
  qRef.current = q

  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

    const close = () => {
      setActive(false)
      setQ('')
    }

    const execute = async () => {
      const query = qRef.current.trim()
      setActive(false)
      setQ('')
      if (!query) return
      const s = useMail.getState()
      s.setSearch(query)
      s.setScope({ kind: 'search', title: `搜索：${query}` })
      await useMail.getState().loadMessages()
      const st = useMail.getState()
      if (st.messages.length) st.select(st.messages[0].id)
      toast(st.messages.length ? `声呐命中 ${st.total} 封${st.messages.length ? '，已打开第一封' : ''}` : `没有找到「${query}」`)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && active) return close()
      if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return
      if (!active) {
        if (typing(e.target)) return
        e.preventDefault()
        e.stopPropagation()
        setQ('')
        setActive(true)
        requestAnimationFrame(() => inputRef.current?.focus())
      } else {
        // 声呐态：空格保留为「松开执行」键，不写入查询
        e.preventDefault()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && active) {
        e.preventDefault()
        void execute()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [active])

  if (!active) return null
  return (
    <div className="sonar-rise fixed bottom-24 left-1/2 z-[55]">
      <div className="liquid-glass pop-in rounded-full pl-4 pr-3.5 py-2.5 flex items-center gap-2.5 w-[440px] max-w-[92vw]">
        <span className="relative flex items-center justify-center shrink-0" style={{ color: 'var(--accent)' }}>
          <span className="ripple-ring" />
          <span className="ripple-ring" style={{ animationDelay: '.7s' }} />
          <IconSearch width={15} height={15} />
        </span>
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="声呐检索 · 说个关键词"
          className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-[var(--faint)]"
          style={{ color: 'var(--fg)' }}
        />
        <span className="text-[11px] shrink-0 whitespace-nowrap" style={{ color: 'var(--faint)' }}>
          松开空格跳转 · Esc 退出
        </span>
      </div>
    </div>
  )
}