import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { IconClose } from '../../components/icons'
import type { Address } from '@shared/types'
import type { RecipientSuggestion } from '@shared/ipc'
import { isValidEmail, mergeRecipients, parseRecipients, recipientText } from './recipients'

export interface RecipientFieldHandle {
  focus(): void
  /** 把输入框里还没成胶囊的文字提交成胶囊（发送 / 存草稿前调用），返回提交后的完整列表 */
  flush(): Address[]
}

interface Props {
  label: string
  value: Address[]
  onChange(next: Address[]): void
  /** 行尾附加内容（抄送 / 密送开关） */
  trailing?: React.ReactNode
  autoFocus?: boolean
}

/**
 * 地址胶囊输入：回车 / 逗号 / 分号 / 空格（已是完整地址时）/ 粘贴多个地址自动成胶囊；
 * 退格删最后一个，双击胶囊回到输入框编辑；非法地址标红；输入时下拉联想本地联系人。
 */
export const RecipientField = forwardRef<RecipientFieldHandle, Props>(function RecipientField(props, ref) {
  const { value, onChange } = props
  const [text, setText] = useState('')
  const [sugs, setSugs] = useState<RecipientSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  const textRef = useRef(text)
  textRef.current = text

  const commit = (raw: string): Address[] => {
    const parsed = parseRecipients(raw)
    setText('')
    setOpen(false)
    if (!parsed.length) return value
    const next = mergeRecipients(value, parsed)
    onChange(next)
    return next
  }

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    flush: () => (text.trim() ? commit(text) : value)
  }))

  // 联想：输入停顿 80ms 后查询，已选地址不再出现
  useEffect(() => {
    const q = text.trim()
    if (!q) {
      setSugs([])
      setOpen(false)
      return
    }
    const my = ++seq.current
    const t = setTimeout(async () => {
      const list = await api.suggestRecipients(q, 8).catch(() => [] as RecipientSuggestion[])
      if (my !== seq.current) return
      const chosen = new Set(value.map(a => a.address.toLowerCase()))
      const rest = list.filter(s => !chosen.has(s.address.toLowerCase()))
      setSugs(rest)
      setActive(0)
      setOpen(rest.length > 0)
    }, 80)
    return () => clearTimeout(t)
  }, [text, value])

  const pick = (s: RecipientSuggestion) => {
    onChange(mergeRecipients(value, [s.name ? { name: s.name, address: s.address } : { address: s.address }]))
    setText('')
    setOpen(false)
    inputRef.current?.focus()
  }

  const remove = (i: number) => onChange(value.filter((_, j) => j !== i))

  const editChip = (i: number) => {
    const a = value[i]
    onChange(value.filter((_, j) => j !== i))
    setText(recipientText(a))
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (open && sugs.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive(a => (a + 1) % sugs.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive(a => (a - 1 + sugs.length) % sugs.length)
        return
      }
      if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        e.preventDefault()
        pick(sugs[active] ?? sugs[0])
        return
      }
      if (e.key === 'Escape') {
        // 只关联想，不冒泡到窗口级 Esc
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && text.trim()) {
      e.preventDefault()
      commit(text)
      return
    }
    if (e.key === 'Backspace' && !text && value.length) {
      e.preventDefault()
      remove(value.length - 1)
    }
  }

  const onInput = (v: string) => {
    // 逗号 / 分号随时成胶囊；空格只在已是完整地址时成胶囊（姓名里可以有空格）
    if (/[,;，；\n]/.test(v)) {
      const parts = v.split(/[,;，；\n]/)
      const tail = parts.pop() ?? ''
      commit(parts.join(','))
      setText(tail.trimStart())
      return
    }
    if (/\s$/.test(v) && isValidEmail(v.trim()) && !/</.test(v)) {
      commit(v)
      return
    }
    setText(v)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text')
    if ((pasted.match(/@/g)?.length ?? 0) >= 1 && /[,;，；\s<]/.test(pasted.trim())) {
      e.preventDefault()
      commit(`${text} ${pasted}`)
    }
  }

  return (
    <div className="cmp-row relative" onMouseDown={e => {
      if (e.target === e.currentTarget) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }}>
      <label className="cmp-label" onClick={() => inputRef.current?.focus()}>{props.label}</label>
      <div className="cmp-chips" onMouseDown={e => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          inputRef.current?.focus()
        }
      }}>
        {value.map((a, i) => {
          const ok = isValidEmail(a.address)
          return (
            <span
              key={`${a.address}-${i}`}
              className="rc-chip"
              data-invalid={ok ? undefined : ''}
              title={ok ? (a.name ? `${a.name} <${a.address}>` : a.address) : `地址格式不正确：${a.address}（双击修改）`}
              onDoubleClick={() => editChip(i)}
            >
              <span className="truncate">{a.name || a.address}</span>
              <button
                type="button"
                tabIndex={-1}
                className="rc-chip-x"
                aria-label={`移除 ${a.address}`}
                onMouseDown={e => e.preventDefault()}
                onClick={() => remove(i)}
              >
                <IconClose width={10} height={10} />
              </button>
            </span>
          )
        })}
        <input
          ref={inputRef}
          value={text}
          autoFocus={props.autoFocus}
          onChange={e => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            // 点联想项时先触发 blur：延迟提交，让 pick 先执行
            setTimeout(() => {
              if (document.activeElement === inputRef.current) return
              setOpen(false)
              if (textRef.current.trim()) commit(textRef.current)
            }, 120)
          }}
          spellCheck={false}
          className="cmp-input flex-1 min-w-[140px] selectable"
          placeholder={value.length ? '' : '输入姓名或地址'}
          aria-label={props.label}
          aria-expanded={open}
          role="combobox"
        />
      </div>
      {props.trailing}
      {open && sugs.length > 0 && (
        <div className="cmp-pop rc-sugs pop-in" role="listbox">
          {sugs.map((s, i) => (
            <button
              key={s.address}
              type="button"
              role="option"
              aria-selected={i === active}
              data-active={i === active ? '' : undefined}
              className="rc-sug"
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(s)}
            >
              <span className="rc-avatar" aria-hidden>{(s.name || s.address).trim().slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0 flex-1 flex flex-col">
                <span className="rc-sug-name truncate"><Hl text={s.name || s.address} q={text.trim()} range={s.name ? s.nameHit : null} /></span>
                {s.name && <span className="rc-sug-addr truncate"><Hl text={s.address} q={text.trim()} /></span>}
              </span>
              <span className="rc-sug-meta tnum">{s.sentByMe > 0 ? `发过 ${s.sentByMe}` : `往来 ${s.total}`}</span>
            </button>
          ))}
          <div className="rc-sug-foot">↑↓ 选择 · ↩ / Tab 确认 · Esc 关闭</div>
        </div>
      )}
    </div>
  )
})

/** 匹配片段加粗（不用荧光：联想结果不是 AI 产出）；拼音命中时按主进程给的区间加粗（如输入 wxm → 王小明） */
function Hl({ text, q, range }: { text: string; q: string; range?: [number, number] | null }) {
  if (!q) return <>{text}</>
  let i = text.toLowerCase().indexOf(q.toLowerCase())
  let end = i + q.length
  if (i < 0 && range && range[1] > range[0] && range[1] <= text.length) {
    i = range[0]
    end = range[1]
  }
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <b className="rc-match">{text.slice(i, end)}</b>
      {text.slice(end)}
    </>
  )
}
