import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useWorkbench } from './store'
import { conflictsFor } from './planning'
import { plannedAt, type WorkItem } from './model'
import { themedStyles, T } from '../theme'
import { notice } from '../ui/Notice'
export function TaskActions({ item, onClose }: { item: WorkItem; onClose(): void }) {
  const work = useWorkbench()
  const run = async (fn: () => Promise<void>, label: string) => { try { await fn(); notice(label, work.snapshotUndo()); onClose() } catch (e) { Alert.alert('操作未完成', String(e)) } }
  const shift = (minutes: number) => {
    const at = (plannedAt(item) ?? Date.now()) + minutes * 60000
    const conflicts = conflictsFor({ ...item, dueAt: at, data: { ...item.data, fixedAt: at, scheduledAt: at, unscheduled: false } }, work.items)
    const save = () => void run(() => work.save({ id: item.id, title: item.title, content: item.data.content ?? item.data.notes ?? '', at, fixed: true, minutes: Number(item.data.minutes) || 15, priority: item.data.priority, reminder: item.data.reminder, source: item.data.source }), '安排时间已更新')
    if (conflicts.length) Alert.alert('时间冲突', `与“${conflicts[0].title}”重叠。仍保留这个固定时间？`, [{ text: '取消', style: 'cancel' }, { text: '保留时间', onPress: save }]); else save()
  }
  const action = (label: string, fn: () => void, danger = false) => <Pressable key={label} accessibilityRole="button" style={s.action} onPress={fn}><Text style={{ color: danger ? T.danger : T.accent, fontSize: 15 }}>{label}</Text></Pressable>
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={s.overlay}><Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="关闭待办操作" /><View style={s.sheet}><Text style={s.title} numberOfLines={2}>{item.title}</Text>
    {action('编辑 / 安排时间', () => { onClose(); work.openCapture({ itemId: item.id, source: item.data.source }) })}
    {item.kind === 'memo' ? action(item.data.pinned ? '取消置顶' : '置顶便签', () => void run(() => work.pin(item.id), '便签置顶已更新')) : <>{action(item.status === 'done' ? '重新打开' : '完成', () => void run(() => work.complete(item.id), '待办状态已更新'))}{item.status === 'open' && <>{action('提前 15 分钟', () => shift(-15))}{action('推迟 15 分钟', () => shift(15))}</>}</>}
    {action('移除', () => void run(() => work.remove(item.id), '已移除'), true)}{action('取消', onClose)}
  </View></View></Modal>
}
const s = themedStyles(() => StyleSheet.create({ overlay: { flex: 1, backgroundColor: T.scrim, justifyContent: 'flex-end' }, sheet: { padding: 22, paddingBottom: 36, backgroundColor: T.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxWidth: 600, width: '100%', alignSelf: 'center' }, title: { color: T.ink, fontSize: 18, fontWeight: '600', marginBottom: 12 }, action: { minHeight: 49, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline } }))
