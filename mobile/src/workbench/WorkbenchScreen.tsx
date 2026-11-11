import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Pressable, LayoutAnimation, Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { useWorkbench } from './store'
import { dayStart, dayEnd, durationOf, plannedAt, type WorkItem } from './model'
import { themedStyles, T } from '../theme'
import { Icon } from '../ui/Icon'
import { PlanningSheet } from './PlanningSheet'
import { ReorderRow } from './ReorderRow'
import { TaskActions } from './TaskActions'
import { conflictsFor } from './planning'
import { notice } from '../ui/Notice'
import { SearchText } from '../ui/SearchText'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { linkToCore } from '../native/LinkToCore'
import { useMail } from '../store/mail'
import { ActionRow } from '../ui/ActionRow'
import { InlineEditor } from './InlineEditor'
import { CollectionSheet } from './CollectionSheet'

const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
export function WorkbenchScreen({ mode }: { mode: 'today' | 'notes' }) {
  const { items, openCapture, complete, pin, reorder, schedule, error } = useWorkbench()
  const reduced = useReducedMotion(), heights = useRef<number[]>([])
  const [collection, setCollection] = useState<string | null>(null), [collections, setCollections] = useState(false), [movingCollection, setMovingCollection] = useState(false)
  useEffect(() => { useWorkbench.setState({ activeCollection: collection }); return () => useWorkbench.setState({ activeCollection: null }) }, [collection])
  const [expanded, setExpanded] = useState<string | null>(null), [selecting, setSelecting] = useState(false), [selected, setSelected] = useState<Set<string>>(new Set()), [busy, setBusy] = useState(false)
  useEffect(() => { setExpanded(null); setSelecting(false); setSelected(new Set()) }, [mode])
  const [dragging, setDragging] = useState(false), [planning, setPlanning] = useState(false), [actionId, setActionId] = useState<string | null>(null)
  const animate = () => { if (!reduced && Platform.OS === 'ios') LayoutAnimation.configureNext({ ...LayoutAnimation.Presets.easeInEaseOut, duration: 180 }) }
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'today' | 'all' | 'done'>('today')
  const [now, setNow] = useState(Date.now()), [scheduling, setScheduling] = useState(false)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const notes = mode === 'notes'
  const list = useMemo(() => items.filter(i => i.status !== 'dismissed' && i.kind === (notes ? 'memo' : 'todo'))
    .filter(i => notes || (filter === 'done' ? i.status === 'done' : i.status === 'open' && (filter === 'all' || !plannedAt(i) || plannedAt(i)! < dayEnd(now))))
    .filter(i => collection === null || (i.data.collection ?? '') === collection)
    .filter(i => !query || `${i.title} ${i.data.content ?? i.data.notes ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => notes ? Number(!!b.data.pinned) - Number(!!a.data.pinned) || b.data.updatedAt - a.data.updatedAt : (plannedAt(a) ?? Infinity) - (plannedAt(b) ?? Infinity) || (Number(a.data.order ?? Infinity) - Number(b.data.order ?? Infinity) || 0) || (a.data.priority ?? 2) - (b.data.priority ?? 2)), [items, notes, query, filter, now, collection])
  const open = items.filter(i => i.kind === 'todo' && i.status === 'open' && (!plannedAt(i) || plannedAt(i)! < dayEnd(now)))
  const minutes = open.reduce((n, i) => n + durationOf(i), 0)
  const act = (fn: () => Promise<unknown>, label = '已更新') => { animate(); void linkToCore.haptic('light'); void fn().then(() => notice(label, useWorkbench.getState().snapshotUndo())).catch(e => Alert.alert('操作未完成', e instanceof Error ? e.message : String(e))) }
  const menu = (item: WorkItem) => setActionId(item.id)
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const select = (id: string) => { if (expanded) return; setSelecting(true); toggle(id) }
  const batch = async (action: 'remove' | 'complete' | 'reopen' | 'tomorrow' | 'pin') => {
    if (busy) return
    setBusy(true)
    try { await useWorkbench.getState().batch([...selected], action); setSelected(new Set()); setSelecting(false); notice('已更新所选记录', useWorkbench.getState().snapshotUndo()) }
    catch (e) { Alert.alert('操作未完成', String(e)) } finally { setBusy(false) }
  }
  heights.current.length = list.length
  const render = ({ item, index }: { item: WorkItem; index: number }) => {
    const at = plannedAt(item), overdue = at && at < dayStart(now)
    const conflicts = conflictsFor(item, items)
    return <ReorderRow index={index} heights={heights.current} enabled={!selecting && !expanded && !notes && filter === 'today' && item.status === 'open' && !item.data.fixedAt} onDragging={setDragging} onDrop={target => { const ids = list.map(i => i.id); ids.splice(target, 0, ids.splice(index, 1)[0]); act(() => reorder(ids), '顺序与今日排程已更新') }}><ActionRow fullSwipeTrailing disabled={selecting || !!expanded} leading={{ label: notes ? (item.data.pinned ? '取消置顶' : '置顶') : item.status === 'done' ? '重新打开' : '完成', run: () => act(() => notes ? pin(item.id) : complete(item.id), '记录已更新') }} trailing={[{ label: '删除', danger: true, run: () => act(() => useWorkbench.getState().remove(item.id), '已删除') }]}><View style={s.row}>
      {selecting && <Pressable accessibilityRole="checkbox" accessibilityLabel={`选择 ${item.title}`} accessibilityState={{ checked: selected.has(item.id) }} disabled={busy} onPress={() => toggle(item.id)} style={s.more}><Text style={{ color: T.accent, fontSize: 20 }}>{selected.has(item.id) ? '✓' : '○'}</Text></Pressable>}
      {!notes && !selecting && <View style={s.time}><Text style={[s.timeText, overdue ? { color: T.danger } : null]}>{at ? clock(at) : '待安排'}</Text><Text style={s.duration}>{durationOf(item)} 分</Text></View>}
      <View accessible={false} style={[s.card, selected.has(item.id) && { borderColor: T.accent }, item.status === 'done' && { opacity: 0.7 }]}>
        {expanded !== item.id && <View style={s.cardTop}><Pressable accessibilityRole="button" accessibilityLabel={`展开${notes ? '随手记' : '待办'}：${item.title}`} accessibilityState={{ expanded: expanded === item.id }} onPress={() => { if (selecting) toggle(item.id); else if (!expanded) { animate(); setExpanded(item.id) } }} onLongPress={() => select(item.id)} style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}><SearchText query={query} style={[s.cardTitle, { flex: 0 }]} numberOfLines={2}>{`${item.data.pinned ? '· ' : ''}${item.title}`}</SearchText></Pressable>{notes && !selecting && <Pressable accessibilityRole="button" disabled={!!expanded} accessibilityLabel={item.data.pinned ? '取消置顶便签' : '置顶便签'} onPress={() => act(() => pin(item.id), '便签置顶已更新')} style={s.more}><Text style={{ color: item.data.pinned ? T.accent : T.faint, fontSize: 11 }}>{item.data.pinned ? '已置顶' : '置顶'}</Text></Pressable>}{!notes && !selecting && <Pressable disabled={!!expanded} accessibilityRole="checkbox" accessibilityState={{ checked: item.status === 'done' }} accessibilityLabel={`完成 ${item.title}`} onPress={() => act(() => complete(item.id), item.status === 'done' ? '待办已重新打开' : '待办已完成')} style={[s.checkbox, item.status === 'done' && { backgroundColor: T.accent }]}>{item.status === 'done' && <Icon name="check" size={16} color={T.accentInk} />}</Pressable>}</View>}
        {expanded === item.id && <InlineEditor key={item.id} item={item} onClose={() => setExpanded(null)} />}
        {expanded !== item.id && !!(item.data.content || item.data.notes) && <Text style={s.preview} numberOfLines={notes ? 4 : 2}>{item.data.content || item.data.notes}</Text>}
        {!!conflicts.length && <Text style={{ color: T.danger, fontSize: 11, marginTop: 8 }}>时间冲突 · 与“{conflicts[0].title}”重叠</Text>}
        <View style={s.meta}><Text style={[s.tag, { color: overdue ? T.danger : T.faint }]}>{notes ? (item.data.pinned ? '置顶便签' : '随手记') : overdue ? '已逾期' : item.data.fixedAt ? '固定时间' : item.data.scheduledAt ? '自动排程' : '待安排'}</Text>{!!item.data.source && <Pressable accessibilityRole="button" accessibilityLabel="打开关联邮件" onPress={() => void useMail.getState().openSource(item.data.source!).catch(e => Alert.alert('原邮件暂不可用', String(e)))} style={s.source}><Text numberOfLines={1} style={s.sourceText}>邮件 · {item.data.source.subject}</Text></Pressable>}</View>
      </View>
      {!selecting && <Pressable accessibilityRole="button" disabled={!!expanded} accessibilityLabel={`${item.title}的更多操作`} onPress={() => menu(item)} style={s.more}><Icon name="more" size={18} /></Pressable>}
    </View></ActionRow></ReorderRow>
  }
  const header = <View style={list.length ? { marginHorizontal: -18 } : undefined}>
    <View style={s.header}><View style={{ flex: 1 }}><Text maxFontSizeMultiplier={1.8} style={s.eyebrow}>{notes ? '想法留在这里' : new Date(now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</Text><Text maxFontSizeMultiplier={1.8} style={s.title}>{notes ? '随手记' : '今日'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="新建随手记" onPress={() => openCapture()} style={s.new}><Icon name="plus" color={T.accent} /></Pressable></View>
    {!expanded && <View style={{ flexDirection: 'row', paddingHorizontal: 20, gap: 10 }}>{([{ id: 'today', label: '待办时间轴' }, { id: 'notes', label: '随手记' }] as const).map(t => <Pressable key={t.id} accessibilityRole="tab" disabled={!!expanded} accessibilityLabel={t.label} accessibilityState={{ selected: mode === t.id }} onPress={() => useMail.getState().setTab(t.id)} style={[s.filter, mode === t.id && s.filterOn]}><Text maxFontSizeMultiplier={1.6} style={s.filterText}>{t.label}</Text></Pressable>)}</View>}
    {!notes && !expanded && <View style={s.summary}><View><Text maxFontSizeMultiplier={1.8} style={s.summaryNumber}>{open.length}<Text style={s.summaryUnit}> 件待办</Text></Text><Text style={s.summaryText}>预计 {Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} 小时 ` : ''}{minutes % 60} 分钟 · 给今天留一点余地</Text></View><Pressable accessibilityRole="button" disabled={scheduling} onPress={() => { setScheduling(true); animate(); void schedule().then(remaining => notice(remaining ? `${remaining} 件排不下，已保留待安排` : '今日已排好，固定时间保持不变', useWorkbench.getState().snapshotUndo())).catch(e => Alert.alert('排程失败', String(e))).finally(() => setScheduling(false)) }} style={s.auto}><Text maxFontSizeMultiplier={1.6} style={s.autoText}>{scheduling ? '安排中…' : '自动排程'}</Text></Pressable></View>}
    {!notes && !expanded && !selecting && <Pressable accessibilityRole="button" accessibilityLabel="设置可用时段" onPress={() => setPlanning(true)} style={{ paddingHorizontal: 24, minHeight: 44, justifyContent: 'center' }}><Text style={{ color: T.accent, fontSize: 12 }}>可用时段与休息 · 拖动 ≡ 调整顺序和安排</Text></Pressable>}
    {!expanded && <View style={s.tools}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="待办与随手记文件夹" disabled={busy} onPress={() => setCollections(true)} style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}><Text numberOfLines={1} style={s.autoText}>文件夹 · {collection === null ? '全部' : collection || '未分组'} ▾</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setSelecting(!selecting); setSelected(new Set()) }} style={{ minHeight: 44, justifyContent: 'center' }}><Text maxFontSizeMultiplier={1.6} style={s.autoText}>{selecting ? '取消选择' : '批量选择'}</Text></Pressable>
        {selecting ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => setSelected(new Set(list.map(i => i.id)))} style={s.filter}><Text maxFontSizeMultiplier={1.6} style={s.autoText}>全选</Text></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel="搜索待办或随手记" onPress={() => { setSearchOpen(!searchOpen); if (searchOpen) setQuery('') }} style={[s.more, { marginTop: 0 }]}><Icon name="search" size={20} /></Pressable>}
      </View>
      {searchOpen && <TextInput accessibilityLabel={notes ? '搜索随手记' : '搜索待办'} value={query} onChangeText={setQuery} placeholder={notes ? '找一段想法…' : '找一件事…'} placeholderTextColor={T.faint} style={s.search} />}
      {!notes && !selecting && <View style={s.filters}>{(['today', 'all', 'done'] as const).map((v, i) => <Pressable accessibilityRole="button" accessibilityState={{ selected: filter === v }} key={v} onPress={() => setFilter(v)} style={[s.filter, filter === v && s.filterOn]}><Text maxFontSizeMultiplier={1.6} style={s.filterText}>{['今日', '全部', '完成'][i]}</Text></Pressable>)}</View>}
    </View>}

    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
  </View>
  return <View style={s.root}>
    {selecting && <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 20, backgroundColor: T.surfaceAlt, gap: 14 }}><Pressable accessibilityRole="button" disabled={busy || !selected.size} onPress={() => setMovingCollection(true)} style={s.filter}><Text maxFontSizeMultiplier={1.6} style={s.autoText}>移到文件夹</Text></Pressable>{([{ action: notes ? 'pin' : filter === 'done' ? 'reopen' : 'complete', label: notes ? '置顶' : filter === 'done' ? '重新打开' : '完成' }, { action: 'tomorrow', label: '移到明天' }, { action: 'remove', label: '删除' }] as const).map(a => <Pressable accessibilityRole="button" key={a.action} disabled={busy || !selected.size} onPress={() => void batch(a.action)} style={s.filter}><Text style={{ color: a.action === 'remove' ? T.danger : T.accent, opacity: busy || !selected.size ? 0.4 : 1 }}>{busy ? '处理中…' : a.label}</Text></Pressable>)}</View>}
    <FlatList ListHeaderComponent={header} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets scrollEnabled={!dragging} data={list} keyExtractor={i => i.id} renderItem={render} contentContainerStyle={list.length ? s.list : s.emptyList} ListFooterComponent={list.length ? <Text style={{ color: T.faint, fontSize: 11, textAlign: 'center', padding: 14 }}>左滑快删 · {notes ? '右滑置顶' : '右滑完成'} · 长按多选</Text> : undefined} ListEmptyComponent={<View style={s.empty}><Icon name={notes ? 'note' : 'today'} size={38} color={T.accent} /><Text maxFontSizeMultiplier={1.8} style={s.emptyTitle}>{query ? '没有找到匹配内容' : notes ? '把想法放下来' : '今天，先从一件事开始'}</Text><Text style={s.emptyText}>用底部“＋”随手记；填上时间，就成为待办。{!notes ? '也可以从邮件直接转入。' : ''}</Text></View>} />
    {collections && <CollectionSheet onChoose={setCollection} onClose={() => setCollections(false)} />}
    {movingCollection && <CollectionSheet ids={[...selected]} onChoose={setCollection} onClose={() => { setMovingCollection(false); setSelecting(false); setSelected(new Set()) }} />}
    {planning && <PlanningSheet onClose={() => setPlanning(false)} />}
    {!!actionId && !!items.find(i => i.id === actionId) && <TaskActions item={items.find(i => i.id === actionId)!} onClose={() => setActionId(null)} />}
  </View>
}
const s = themedStyles(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper }, header: { padding: 22, paddingBottom: 14, flexDirection: 'row', alignItems: 'center' }, eyebrow: { color: T.faint, fontSize: 12, marginBottom: 6 }, title: { color: T.ink, fontSize: 28, fontWeight: '700' }, new: { width: 48, height: 48, borderRadius: 12, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center' },
  summary: { marginHorizontal: 20, padding: 18, borderRadius: 14, backgroundColor: T.surface, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, summaryNumber: { color: T.ink, fontSize: 28, fontWeight: '700' }, summaryUnit: { fontSize: 13, fontWeight: '400' }, summaryText: { color: T.faint, fontSize: 11, marginTop: 6, maxWidth: 220, lineHeight: 17 }, auto: { minHeight: 44, paddingHorizontal: 12, borderRadius: 12, backgroundColor: T.accentSoft, justifyContent: 'center' }, autoText: { color: T.accent, fontSize: 12, fontWeight: '600' },
  tools: { paddingHorizontal: 20, paddingVertical: 8, gap: 8 }, search: { color: T.ink, minHeight: 46, borderRadius: 13, backgroundColor: T.surfaceAlt, paddingHorizontal: 14, fontSize: 14 }, filters: { flexDirection: 'row', gap: 8 }, filter: { paddingHorizontal: 16, minHeight: 44, borderRadius: 12, justifyContent: 'center' }, filterOn: { backgroundColor: T.surface }, filterText: { color: T.inkSoft, fontSize: 13 }, list: { maxWidth: 900, width: '100%', alignSelf: 'center', padding: 18, paddingTop: 0, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }, time: { width: 58, paddingTop: 15 }, timeText: { fontSize: 12, color: T.inkSoft, fontWeight: '600' }, duration: { fontSize: 10, color: T.faint, marginTop: 5 }, card: { flex: 1, padding: 15, backgroundColor: T.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline }, cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 }, cardTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: T.ink, lineHeight: 22 }, checkbox: { width: 44, height: 44, borderRadius: 14, borderWidth: 1, borderColor: T.hairline, alignItems: 'center', justifyContent: 'center' }, preview: { fontSize: 13, color: T.inkSoft, lineHeight: 21, marginTop: 8 }, meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 10, gap: 8 }, tag: { fontSize: 10 }, source: { maxWidth: '80%', minHeight: 44, justifyContent: 'center' }, sourceText: { color: T.accent, fontSize: 11 }, more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 3 },
  emptyList: { flexGrow: 1 }, empty: { flex: 1, minHeight: 240, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 14 }, emptyTitle: { fontSize: 19, fontWeight: '600', color: T.ink }, emptyText: { color: T.faint, fontSize: 13, lineHeight: 22, textAlign: 'center', maxWidth: 290 }, error: { color: T.danger, paddingHorizontal: 20 }
}))
