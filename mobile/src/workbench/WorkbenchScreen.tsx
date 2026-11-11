import { useEffect, useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { useWorkbench } from './store'
import { dayStart, dayEnd, durationOf, plannedAt, type WorkItem } from './model'
import { T } from '../theme'
import { Icon } from '../ui/Icon'
import { useMail } from '../store/mail'

const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
export function WorkbenchScreen({ mode }: { mode: 'today' | 'notes' }) {
  const { items, openCapture, complete, remove, pin, schedule, error } = useWorkbench()
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'today' | 'all' | 'done'>('today')
  const [now, setNow] = useState(Date.now()), [scheduling, setScheduling] = useState(false)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const notes = mode === 'notes'
  const list = useMemo(() => items.filter(i => i.status !== 'dismissed' && i.kind === (notes ? 'memo' : 'todo'))
    .filter(i => notes || (filter === 'done' ? i.status === 'done' : i.status === 'open' && (filter === 'all' || !plannedAt(i) || plannedAt(i)! < dayEnd(now))))
    .filter(i => !query || `${i.title} ${i.data.content ?? i.data.notes ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => notes ? Number(!!b.data.pinned) - Number(!!a.data.pinned) || b.data.updatedAt - a.data.updatedAt : (plannedAt(a) ?? Infinity) - (plannedAt(b) ?? Infinity) || (a.data.priority ?? 2) - (b.data.priority ?? 2)), [items, notes, query, filter, now])
  const open = items.filter(i => i.kind === 'todo' && i.status === 'open' && (!plannedAt(i) || plannedAt(i)! < dayEnd(now)))
  const minutes = open.reduce((n, i) => n + durationOf(i), 0)
  const act = (fn: () => Promise<unknown>) => void fn().catch(e => Alert.alert('操作未完成', e instanceof Error ? e.message : String(e)))
  const menu = (item: WorkItem) => Alert.alert(item.title, item.data.source ? `关联邮件：${item.data.source.subject}` : '随时可以补充内容和安排时间。', [
    { text: '编辑 / 安排时间', onPress: () => openCapture({ itemId: item.id, source: item.data.source }) },
    notes ? { text: item.data.pinned ? '取消置顶' : '置顶', onPress: () => act(() => pin(item.id)) } : { text: item.status === 'done' ? '重新打开' : '完成', onPress: () => act(() => complete(item.id)) },
    { text: '移除', style: 'destructive', onPress: () => act(() => remove(item.id)) }, ...(Platform.OS === 'ios' ? [{ text: '取消', style: 'cancel' as const }] : [])
  ], { cancelable: true })
  const render = ({ item }: { item: WorkItem }) => {
    const at = plannedAt(item), overdue = at && at < dayStart(now)
    return <View style={s.row}>
      {!notes && <View style={s.time}><Text style={[s.timeText, overdue ? { color: T.danger } : null]}>{at ? clock(at) : '待安排'}</Text><Text style={s.duration}>{durationOf(item)} 分</Text></View>}
      <Pressable accessibilityRole="button" accessibilityLabel={`编辑${notes ? '随手记' : '待办'}：${item.title}`} onPress={() => openCapture({ itemId: item.id, source: item.data.source })} onLongPress={() => menu(item)} style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }, item.status === 'done' && { opacity: 0.55 }]}>
        <View style={s.cardTop}><Text style={s.cardTitle} numberOfLines={2}>{item.data.pinned ? '· ' : ''}{item.title}</Text>{!notes && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: item.status === 'done' }} accessibilityLabel={`完成 ${item.title}`} onPress={() => act(() => complete(item.id))} style={[s.checkbox, item.status === 'done' && { backgroundColor: T.accent }]}>{item.status === 'done' && <Icon name="check" size={16} color={T.white} />}</Pressable>}</View>
        {!!(item.data.content || item.data.notes) && <Text style={s.preview} numberOfLines={notes ? 4 : 2}>{item.data.content || item.data.notes}</Text>}
        <View style={s.meta}><Text style={[s.tag, { color: overdue ? T.danger : T.faint }]}>{notes ? (item.data.pinned ? '置顶便签' : '随手记') : overdue ? '已逾期' : item.data.fixedAt ? '固定时间' : item.data.scheduledAt ? '自动排程' : '待安排'}</Text>{!!item.data.source && <Pressable accessibilityRole="button" accessibilityLabel="打开关联邮件" onPress={() => act(() => useMail.getState().openSource(item.data.source!))} style={s.source}><Text numberOfLines={1} style={s.sourceText}>邮件 · {item.data.source.subject}</Text></Pressable>}</View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}的更多操作`} onPress={() => menu(item)} style={s.more}><Icon name="more" size={18} /></Pressable>
    </View>
  }
  return <View style={s.root}>
    <View style={s.header}><View style={{ flex: 1 }}><Text style={s.eyebrow}>{notes ? '想法留在这里' : new Date(now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</Text><Text style={s.title}>{notes ? '随手记' : '今日'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="新建随手记" onPress={() => openCapture()} style={s.new}><Icon name="plus" color={T.accent} /></Pressable></View>
    {!notes && <View style={s.summary}><View><Text style={s.summaryNumber}>{open.length}<Text style={s.summaryUnit}> 件待办</Text></Text><Text style={s.summaryText}>预计 {Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} 小时 ` : ''}{minutes % 60} 分钟 · 给今天留一点余地</Text></View><Pressable accessibilityRole="button" disabled={scheduling} onPress={() => { setScheduling(true); void schedule().then(remaining => Alert.alert('今日已排好', remaining ? `${remaining} 件任务超出今天的可用时间，保留在待安排中。` : '已按优先级填入空档，固定时间保持不变。')).catch(e => Alert.alert('排程失败', String(e))).finally(() => setScheduling(false)) }} style={s.auto}><Text style={s.autoText}>{scheduling ? '安排中…' : '自动排程'}</Text></Pressable></View>}
    <View style={s.tools}><TextInput accessibilityLabel={notes ? '搜索随手记' : '搜索待办'} value={query} onChangeText={setQuery} placeholder={notes ? '找一段想法…' : '找一件事…'} placeholderTextColor={T.faint} style={s.search} />{!notes && <View style={s.filters}>{(['today', 'all', 'done'] as const).map((v, i) => <Pressable accessibilityRole="button" accessibilityState={{ selected: filter === v }} key={v} onPress={() => setFilter(v)} style={[s.filter, filter === v && s.filterOn]}><Text style={s.filterText}>{['今日', '全部', '完成'][i]}</Text></Pressable>)}</View>}</View>
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <FlatList data={list} keyExtractor={i => i.id} renderItem={render} contentContainerStyle={list.length ? s.list : s.emptyList} ListEmptyComponent={<View style={s.empty}><Icon name={notes ? 'note' : 'today'} size={38} color={T.accent} /><Text style={s.emptyTitle}>{query ? '没有找到匹配内容' : notes ? '把想法放下来' : '今天，先从一件事开始'}</Text><Text style={s.emptyText}>用底部“＋”随手记；填上时间，就成为待办。{!notes ? '也可以从邮件直接转入。' : ''}</Text></View>} />
  </View>
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper }, header: { padding: 22, paddingBottom: 14, flexDirection: 'row', alignItems: 'center' }, eyebrow: { color: T.faint, fontSize: 12, marginBottom: 6 }, title: { color: T.ink, fontSize: 30, fontWeight: '700' }, new: { width: 48, height: 48, borderRadius: 16, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center' },
  summary: { marginHorizontal: 20, padding: 18, borderRadius: 20, backgroundColor: T.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, summaryNumber: { color: T.ink, fontSize: 27, fontWeight: '700' }, summaryUnit: { fontSize: 13, fontWeight: '400' }, summaryText: { color: T.faint, fontSize: 11, marginTop: 6, maxWidth: 220, lineHeight: 17 }, auto: { minHeight: 44, paddingHorizontal: 12, borderRadius: 12, backgroundColor: T.accentSoft, justifyContent: 'center' }, autoText: { color: T.accent, fontSize: 12, fontWeight: '600' },
  tools: { padding: 20, paddingBottom: 12, gap: 12 }, search: { color: T.ink, minHeight: 46, borderRadius: 13, backgroundColor: T.surfaceAlt, paddingHorizontal: 14, fontSize: 14 }, filters: { flexDirection: 'row', gap: 8 }, filter: { paddingHorizontal: 16, minHeight: 44, borderRadius: 12, justifyContent: 'center' }, filterOn: { backgroundColor: T.surface }, filterText: { color: T.inkSoft, fontSize: 13 }, list: { padding: 18, paddingTop: 0, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 }, time: { width: 58, paddingTop: 15 }, timeText: { fontSize: 12, color: T.inkSoft, fontWeight: '600' }, duration: { fontSize: 10, color: T.faint, marginTop: 5 }, card: { flex: 1, padding: 15, backgroundColor: T.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline }, cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 }, cardTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: T.ink, lineHeight: 22 }, checkbox: { width: 44, height: 44, borderRadius: 14, borderWidth: 1, borderColor: T.hairline, alignItems: 'center', justifyContent: 'center' }, preview: { fontSize: 13, color: T.inkSoft, lineHeight: 21, marginTop: 8 }, meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 10, gap: 8 }, tag: { fontSize: 10 }, source: { maxWidth: '80%', minHeight: 44, justifyContent: 'center' }, sourceText: { color: T.accent, fontSize: 11 }, more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 3 },
  emptyList: { flexGrow: 1 }, empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 14 }, emptyTitle: { fontSize: 19, fontWeight: '600', color: T.ink }, emptyText: { color: T.faint, fontSize: 13, lineHeight: 22, textAlign: 'center', maxWidth: 290 }, error: { color: T.danger, paddingHorizontal: 20 }
})
