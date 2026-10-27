import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { VaultItemMeta, VaultKind } from '@shared/types'

/**
 * 暂存箱 / 保险箱。
 * 条目整个列表以 safeStorage 加密字符串存在主进程密钥区；这里只拿元数据，
 * 正文按需 reveal。保险箱条目不会被发送到 Litmus（Litmus 是明文 Markdown）。
 */
export function VaultWindow() {
  const [items, setItems] = useState<VaultItemMeta[]>([])
  const [tab, setTab] = useState<VaultKind>('note')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [litmusPath, setLitmusPath] = useState<string | null>(null)
  const [form, setForm] = useState<{ kind: VaultKind; title: string; body: string } | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; kind: VaultKind; title: string; body: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    setLoading(true)
    try {
      const [list, litmus] = await Promise.all([api.vaultList(), api.litmusVaultPath()])
      setItems(list)
      setLitmusPath(litmus)
    } catch (err) {
      setNotice('读取失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    const onFocus = () => { void reload() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (revealed) {
        e.preventDefault()
        setRevealed(null)
      } else if (form) {
        e.preventDefault()
        setForm(null)
      } else {
        window.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revealed, form])

  const visible = useMemo(() => items.filter(i => i.kind === tab), [items, tab])
  const noteCount = items.filter(i => i.kind === 'note').length
  const secretCount = items.filter(i => i.kind === 'secret').length

  const startAdd = () => {
    setNotice('')
    setForm({ kind: tab, title: '', body: '' })
  }

  const save = async () => {
    if (!form || !form.body.trim() || busy) return
    setBusy(true)
    try {
      const r = await api.vaultAdd(form.kind, form.title, form.body)
      if (!r.ok) {
        setNotice(r.error ?? '保存失败')
        return
      }
      setForm(null)
      setNotice(form.kind === 'secret' ? '已存入保险箱（系统钥匙串加密）' : '已暂存')
      await reload()
    } catch (err) {
      setNotice('保存失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  const reveal = async (item: VaultItemMeta) => {
    try {
      const r = await api.vaultReveal(item.id)
      if (!r.ok || typeof r.body !== 'string') {
        setNotice('读取条目失败')
        return
      }
      setRevealed({ id: item.id, kind: item.kind, title: item.title, body: r.body })
    } catch (err) {
      setNotice('读取条目失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const copy = async (id: string) => {
    try {
      const r = await api.vaultCopy(id)
      setNotice(r.ok ? '已复制 · 45 秒后自动清空剪贴板' : r.error ?? '复制失败')
    } catch (err) {
      setNotice('复制失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const remove = async (item: VaultItemMeta) => {
    if (!window.confirm('删除「' + item.title + '」？删除后不可恢复。')) return
    const r = await api.vaultDelete(item.id)
    if (!r.ok) {
      setNotice('系统钥匙串还在解锁，删除失败；请稍后重试')
      return
    }
    if (revealed?.id === item.id) setRevealed(null)
    setNotice('已删除')
    await reload()
  }

  const sendToLitmus = async (item: VaultItemMeta) => {
    if (item.kind === 'secret') {
      setNotice('保险箱内容不会发送到 Litmus')
      return
    }
    try {
      const r = await api.vaultSendToLitmus(item.id)
      if (r.ok) setNotice('已写入 Litmus：' + (r.path ?? ''))
      else if (r.error !== '已取消') setNotice('发送失败：' + (r.error ?? ''))
    } catch (err) {
      setNotice('发送失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false })

  return (
    <div className="h-screen flex flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="drag-region flex items-center gap-3 pl-[76px] pr-4 py-3 border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur shrink-0">
        <div className="w-2 h-2 rounded-full bg-[var(--ok)] shadow-[0_0_10px_var(--ok)]" />
        <div className="text-[15px] font-semibold tracking-wide">暂存箱与保险箱</div>
        <div className="text-xs text-[var(--muted)]">本机钥匙串加密 · 保险箱不进明文库</div>
        <nav className="no-drag ml-auto flex items-center gap-1 p-0.5 rounded-[var(--r-sm)] bg-[var(--hover)]">
          {(
            [
              ['note', '暂存 ' + noteCount],
              ['secret', '保险箱 ' + secretCount]
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={
                'px-3 py-1 rounded-[calc(var(--r-sm)-2px)] text-xs transition-colors ' +
                (tab === k ? 'bg-[var(--surface-strong)] text-[var(--fg)] shadow-[var(--shadow-sm)]' : 'text-[var(--muted)] hover:text-[var(--fg)]')
              }
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => void reload()}
            className="px-2.5 py-1 rounded-[calc(var(--r-sm)-2px)] text-xs border border-[var(--border)] hover:bg-[var(--hover)]"
          >
            刷新
          </button>
          <button
            onClick={startAdd}
            className="ml-1 px-3 py-1 rounded-[calc(var(--r-sm)-2px)] text-xs bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-90"
          >
            新建
          </button>
        </nav>
      </header>

      {notice && (
        <div className="px-5 py-2 text-xs border-b border-[var(--border)] bg-[var(--info-soft)] text-[var(--fg)]" aria-live="polite">
          {notice}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <div className="max-w-[760px] mx-auto px-6 py-6 space-y-3">
          {form && (
            <section className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">{form.kind === 'secret' ? '新建保险箱条目' : '新建暂存'}</div>
                <div className="ml-auto flex items-center gap-1 p-0.5 rounded-[var(--r-sm)] bg-[var(--hover)]">
                  {(
                    [
                      ['note', '暂存'],
                      ['secret', '保险箱']
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setForm({ ...form, kind: k })}
                      className={
                        'px-2.5 py-1 rounded-[calc(var(--r-sm)-2px)] text-[11px] ' +
                        (form.kind === k ? 'bg-[var(--surface-strong)] text-[var(--fg)]' : 'text-[var(--muted)]')
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <input
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                placeholder={form.kind === 'secret' ? '标题（例如：GitHub 备份码）' : '标题（可选）'}
                className="mt-3 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
              <textarea
                value={form.body}
                onChange={e => setForm({ ...form, body: e.target.value })}
                rows={6}
                spellCheck={false}
                autoComplete="off"
                placeholder={form.kind === 'secret' ? '密码、恢复码或个人信息。保存后用系统钥匙串加密。' : '要暂存的内容。会进入同一份加密存储。'}
                className="mt-2 w-full resize-none rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--accent)]"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => void save()}
                  disabled={busy || !form.body.trim()}
                  className="px-4 py-1.5 rounded-[var(--r-sm)] text-xs bg-[var(--accent)] text-[var(--on-accent)] disabled:opacity-40"
                >
                  {busy ? '保存中…' : '保存'}
                </button>
                <button
                  onClick={() => setForm(null)}
                  className="px-3 py-1.5 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)]"
                >
                  取消
                </button>
                <span className="text-[11px] text-[var(--faint)]">内容上限 64KB · 整个列表作为一个密钥项加密</span>
              </div>
            </section>
          )}

          {!form && (
            <section className="rounded-[var(--r-md)] bg-[var(--info-soft)] px-4 py-3 text-[11px] leading-relaxed text-[var(--muted)]">
              {tab === 'secret'
                ? '保险箱用 macOS 钥匙串（safeStorage）加密；密码只在本机、随登录解锁。不会同步到 Litmus、不会写进邮件库。'
                : '暂存适合放一段稍后要用的文字。它和保险箱共用同一份加密存储；发到 Litmus 会写成明文 Markdown。'}
            </section>
          )}

          {loading ? (
            <div className="text-sm text-[var(--faint)] py-10 text-center">读取中…</div>
          ) : visible.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-sm text-[var(--muted)]">{tab === 'secret' ? '保险箱还是空的' : '还没有暂存'}</div>
              <div className="text-[11px] text-[var(--faint)] mt-1">「新建」或从萤火密信阅读窗点「{tab === 'secret' ? '存入保险箱' : '暂存'}」。</div>
            </div>
          ) : (
            visible.map(item => (
              <div key={item.id} className="rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium break-words">{item.title}</div>
                    <div className="mt-1 text-[11px] text-[var(--faint)]">
                      {fmt(item.updatedAt)} · {item.kind === 'secret' ? '已加密' : '暂存'}
                    </div>
                    {item.kind === 'note' && item.preview && (
                      <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--muted)] line-clamp-2">{item.preview}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => void reveal(item)}
                      className="px-2.5 py-1 rounded-[var(--r-sm)] text-[11px] border border-[var(--border)] hover:bg-[var(--hover)]"
                    >
                      查看
                    </button>
                    <button
                      onClick={() => void copy(item.id)}
                      className="px-2.5 py-1 rounded-[var(--r-sm)] text-[11px] border border-[var(--border)] hover:bg-[var(--hover)]"
                    >
                      复制
                    </button>
                    {item.kind === 'note' && (
                      <button
                        onClick={() => void sendToLitmus(item)}
                        className="px-2.5 py-1 rounded-[var(--r-sm)] text-[11px] border border-[var(--border)] hover:bg-[var(--hover)]"
                      >
                        发到 Litmus
                      </button>
                    )}
                    <button
                      onClick={() => void remove(item)}
                      className="px-2.5 py-1 rounded-[var(--r-sm)] text-[11px] border border-[var(--border)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger-ink)]"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <footer className="shrink-0 px-5 py-2 border-t border-[var(--border)] text-[10px] text-[var(--faint)] flex items-center gap-3">
        <span>Esc 关闭</span>
        <span>正文按需解密，列表不携带正文</span>
        <span className="ml-auto">{litmusPath ? 'Litmus：' + litmusPath : '未找到 Litmus 库'}</span>
      </footer>

      {revealed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'var(--scrim)' }} onClick={() => setRevealed(null)}>
          <div
            className="w-full max-w-[640px] max-h-[80vh] overflow-auto rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface-strong)] p-5 shadow-[var(--shadow)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium flex-1 break-words">{revealed.title}</div>
              <span className="text-[10px] text-[var(--faint)]">{revealed.kind === 'secret' ? '保险箱' : '暂存'}</span>
            </div>
            <pre className="mt-3 whitespace-pre-wrap break-words rounded-[var(--r-sm)] bg-[var(--bg-soft)] p-3 text-[13px] leading-relaxed max-h-[52vh] overflow-auto select-text">
              {revealed.body}
            </pre>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => void copy(revealed.id)}
                className="px-3 py-1.5 rounded-[var(--r-sm)] text-xs bg-[var(--accent)] text-[var(--on-accent)]"
              >
                复制
              </button>
              <button
                onClick={() => setRevealed(null)}
                className="px-3 py-1.5 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)]"
              >
                关闭
              </button>
              <span className="ml-auto text-[10px] text-[var(--faint)]">只在内存中显示</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
