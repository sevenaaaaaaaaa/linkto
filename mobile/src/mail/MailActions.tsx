import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { themedStyles, T } from '../theme'
import { useMail, type MobileMessage } from '../store/mail'
import { useWorkbench } from '../workbench/store'
import { notice } from '../ui/Notice'
import { useReducedMotion } from '../hooks/useReducedMotion'
export function sourceOf(m: MobileMessage) { return { accountEmail: m.accountEmail, mailbox: m.mailbox, uid: m.uid, messageId: m.messageId, subject: m.subject, from: m.from, date: m.date } }
export function MailActions({ message, onClose, onPeek }: { message: MobileMessage | null; onClose(): void; onPeek?(message: MobileMessage): void }) {
  const [busy, setBusy] = useState(false), [snoozing, setSnoozing] = useState(false), [error, setError] = useState('')
  const reduced = useReducedMotion()
  const close = () => { if (!busy) { setSnoozing(false); setError(''); onClose() } }
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); setSnoozing(false); onClose() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const move = (kind: 'archive' | 'trash') => run(async () => { const result = await useMail.getState().moveMessage(message!, kind); notice(kind === 'archive' ? '邮件已归档' : '邮件已移至垃圾箱', result.undo) })
  const later = (at: number) => run(async () => { const id = await useWorkbench.getState().snooze(sourceOf(message!), at); useMail.getState().backToInbox(); useMail.getState().closeReading(); notice(useWorkbench.getState().error ? '已稍后处理，本机提醒未开启；可在更多中设置' : '已加入稍后处理，到时回到收件箱', () => useWorkbench.getState().remove(id)) })
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
  const week = new Date(tomorrow); week.setDate(week.getDate() + (8 - week.getDay()) % 7)
  const action = (label: string, fn: () => void, danger = false) => <Pressable key={label} disabled={busy} accessibilityRole="button" onPress={fn} style={s.action}><Text style={[s.label, danger && { color: T.danger }]}>{label}</Text></Pressable>
  return <Modal visible={!!message} transparent animationType={reduced ? 'none' : 'fade'} onRequestClose={close}><View style={s.overlay}><Pressable style={StyleSheet.absoluteFill} accessibilityLabel="关闭邮件操作" onPress={close} /><View style={s.sheet}>
    <Text style={s.title}>{snoozing ? '稍后处理' : '处理邮件'}</Text><Text style={s.subject} numberOfLines={2}>{message?.subject}</Text>
    {snoozing ? <>{action('一小时后', () => void later(Date.now() + 3600000))}{action('明天 09:00', () => void later(tomorrow.getTime()))}{action('下周一 09:00', () => void later(week.getTime()))}<Text style={s.hint}>暂时从本应用收件箱隐藏，时间与状态随待办加密同步。服务器邮件保留。</Text></> : <>{onPeek && action('速览邮件', () => { onPeek(message!); close() })}{action('归档', () => void move('archive'))}{action('稍后处理…', () => setSnoozing(true))}{action(message?.flags.includes('\\Seen') ? '标为未读' : '标为已读', () => void run(() => useMail.getState().toggleSeen(message!)))}{action('移至垃圾箱', () => void move('trash'), true)}</>}
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}{busy ? <Text style={s.hint}>正在处理…</Text> : action('取消', close)}
  </View></View></Modal>
}
const s = themedStyles(() => StyleSheet.create({ overlay: { flex: 1, backgroundColor: T.scrim, justifyContent: 'flex-end' }, sheet: { backgroundColor: T.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingBottom: 36, width: '100%', maxWidth: 600, alignSelf: 'center' }, title: { color: T.ink, fontSize: 20, fontWeight: '700' }, subject: { color: T.faint, fontSize: 13, marginVertical: 12 }, action: { minHeight: 50, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline }, label: { color: T.accent, fontSize: 16 }, hint: { color: T.faint, fontSize: 12, lineHeight: 20, marginTop: 14 }, error: { color: T.danger, marginTop: 14 } }))
