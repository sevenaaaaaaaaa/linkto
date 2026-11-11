import { useEffect, useMemo, useState } from 'react'
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWorkbench } from './store'
import { durationOf, estimateMinutes, parseSchedule, plannedAt } from './model'
import { themedStyles, T } from '../theme'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { SchedulePicker } from './SchedulePicker'

const dateText = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
let captureSession = 0
export function CaptureSheet() {
  const reducedMotion = useReducedMotion()
  const { capture, items, closeCapture, save } = useWorkbench()
  // Keep native text ownership during typing; controlled rewrites can interrupt composition.
  const inputSeed = useMemo(() => {
    const item = items.find(i => i.id === capture?.itemId)
    return { key: ++captureSession, version: item?.data.updatedAt, collection: item?.data.collection ?? capture?.collection, title: item?.title ?? capture?.source?.subject ?? '', content: item?.data.content ?? item?.data.notes ?? capture?.content ?? '' }
  }, [capture])
  const [title, setTitle] = useState(''), [content, setContent] = useState('')
  const [date, setDate] = useState(''), [time, setTime] = useState('09:00')
  const [minutes, setMinutes] = useState(15), [priority, setPriority] = useState<1 | 2 | 3>(2)
  const [reminder, setReminder] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [fixed, setFixed] = useState(false), [manualMinutes, setManualMinutes] = useState(false)
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    if (!capture) return
    const item = items.find(i => i.id === capture.itemId)
    const at = item ? plannedAt(item) ?? item.dueAt : null
    setTitle(inputSeed.title)
    setContent(inputSeed.content)
    setDate(at ? dateText(at) : '')
    setTime(at ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '09:00')
    setMinutes(item ? durationOf(item) : estimateMinutes(capture.source?.subject ?? ''))
    setManualMinutes(!!item)
    setFixed(!!item?.data.fixedAt)
    setPriority(item?.data.priority ?? 2)
    setReminder(item?.data.reminder ?? false)
    setError('')
  }, [capture])
  const submit = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await save({ id: capture?.itemId, title, content, at: parseSchedule(date, date ? time : ''), fixed, minutes, priority, reminder, source: capture?.source, expectedVersion: inputSeed.version, collection: capture?.collection }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <Modal visible={!!capture} presentationStyle="pageSheet" animationType={reducedMotion ? 'fade' : 'slide'} onRequestClose={closeCapture}>
    <SafeAreaView style={s.root} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.header}>
          <Pressable accessibilityRole="button" onPress={() => { if (title || content) Alert.alert('保留这份内容？', '保存后可继续编辑。', [{ text: '继续编辑', style: 'cancel' }, { text: '放弃', style: 'destructive', onPress: closeCapture }]); else closeCapture() }} style={s.hit}><Text style={s.link}>取消</Text></Pressable>
          <Text style={s.heading}>{date ? '安排待办' : '随手记'}</Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void submit()} style={s.hit}><Text style={[s.link, busy && { opacity: 0.4 }]}>{busy ? '保存中' : '保存'}</Text></Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.body}>
          <Text style={s.eyebrow}>{date ? '进入今日时间轴' : '先记下来，安排可以稍后再做'}</Text>
          {typeof inputSeed.collection === 'string' && !!inputSeed.collection && <Text style={s.hint}>文件夹 · {inputSeed.collection}</Text>}
          <TextInput key={`${inputSeed.key}-title`} accessibilityLabel="标题" defaultValue={inputSeed.title} autoCorrect={false} spellCheck={false} onChangeText={v => { setTitle(v); if (!manualMinutes) setMinutes(estimateMinutes(v + content)) }} placeholder="想到什么？" placeholderTextColor={T.faint} style={s.title} maxLength={240} />
          <TextInput key={`${inputSeed.key}-content`} accessibilityLabel="随手记正文" multiline defaultValue={inputSeed.content} onChangeText={setContent} placeholder="记下想法、补充要做的事…" placeholderTextColor={T.faint} style={s.content} textAlignVertical="top" />
          {!!capture?.source && <View style={s.source}><Text style={s.link} numberOfLines={2}>来自邮件 · {capture.source.subject}</Text><Text style={s.hint}>{capture.source.accountEmail}</Text></View>}
          <Text style={s.label}>安排时间 · 填了时间就转为待办</Text>
          <Pressable accessibilityRole="button" onPress={() => setPicking(true)} style={[s.chip, { alignSelf: 'flex-start' }]}><Text style={s.chipText}>选择日期与时间</Text></Pressable>
          <View style={s.row}>{['今天', '明天', '不设时间'].map((label, i) => <Pressable key={label} accessibilityRole="button" style={s.chip} onPress={() => setDate(i === 2 ? '' : dateText(Date.now() + i * 864e5))}><Text style={s.chipText}>{label}</Text></Pressable>)}</View>
          <View style={s.row}><TextInput accessibilityLabel="安排日期，年-月-日" placeholder="YYYY-MM-DD" placeholderTextColor={T.faint} value={date} onChangeText={setDate} style={[s.input, { flex: 1 }]} /><TextInput accessibilityLabel="开始时间，时:分" placeholder="HH:mm" value={time} onChangeText={setTime} style={[s.input, { width: 100 }]} /></View>
          {!!date && <>
            <Text style={s.label}>预计用时 · 按内容建议，可自行调整</Text>
            <View style={s.row}>{[15, 30, 45, 60, 90].map(v => <Pressable key={v} accessibilityRole="button" accessibilityState={{ selected: minutes === v }} style={[s.chip, minutes === v && s.selected]} onPress={() => { setManualMinutes(true); setMinutes(v) }}><Text style={s.chipText}>{v} 分</Text></Pressable>)}</View>
            <View style={[s.row, { justifyContent: 'space-between', marginTop: 16 }]}><Text style={s.label}>固定开始时间（排程时保留）</Text><Switch accessibilityLabel="固定开始时间" value={fixed} onValueChange={setFixed} /></View>
            <Text style={s.label}>优先级</Text><View style={s.row}>{(['重要', '普通', '低'] as const).map((label, i) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected: priority === i + 1 }} style={[s.chip, priority === i + 1 && s.selected]} onPress={() => setPriority((i + 1) as 1 | 2 | 3)}><Text style={s.chipText}>{label}</Text></Pressable>)}</View>
            {(Platform.OS === 'ios' || Platform.OS === 'android') && <View style={[s.row, { justifyContent: 'space-between', marginTop: 20 }]}><Text style={s.label}>到时提醒我</Text><Switch accessibilityLabel="待办到时提醒" value={reminder} onValueChange={setReminder} /></View>}
          </>}
          {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
      {picking && <SchedulePicker initial={(() => { try { return parseSchedule(date, date ? time : '') ?? Date.now() } catch { return Date.now() } })()} onClose={() => setPicking(false)} onSave={at => { setDate(dateText(at)); setTime(new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })); setPicking(false) }} />}
    </SafeAreaView>
  </Modal>
}
const s = themedStyles(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper }, header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline, paddingHorizontal: 12 },
  hit: { minWidth: 64, minHeight: 48, justifyContent: 'center', alignItems: 'center' }, heading: { flex: 1, textAlign: 'center', color: T.ink, fontWeight: '600', fontSize: 16 }, link: { color: T.accent, fontSize: 14, fontWeight: '600' },
  body: { padding: 22, paddingBottom: 48, maxWidth: 720, width: '100%', alignSelf: 'center' }, eyebrow: { color: T.faint, fontSize: 12, marginBottom: 14 }, title: { color: T.ink, fontSize: 25, fontWeight: '700', paddingVertical: 10 }, content: { minHeight: 160, color: T.inkSoft, fontSize: 16, lineHeight: 26, paddingTop: 12 },
  source: { borderLeftWidth: 2, borderLeftColor: T.accent, paddingLeft: 12, paddingVertical: 8, marginVertical: 12 }, hint: { color: T.faint, fontSize: 11, marginTop: 4 }, label: { color: T.inkSoft, fontSize: 13, marginTop: 20, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, chip: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, backgroundColor: T.surface, borderRadius: 12 }, selected: { backgroundColor: T.accentSoft, borderColor: T.accent }, chipText: { color: T.inkSoft, fontSize: 13 }, input: { marginTop: 10, minHeight: 48, backgroundColor: T.surface, borderRadius: 12, paddingHorizontal: 14, color: T.ink, fontSize: 15 }, error: { color: T.danger, marginTop: 16, lineHeight: 20 }
}))
