import { useRef, useState } from 'react'
import { Alert, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { T, themedStyles } from '../theme'
import type { WorkItem } from './model'
import { useWorkbench } from './store'
import { notice } from '../ui/Notice'
import { readInlineDraft, writeInlineDraft, forgetInlineDraft } from './drafts'

export function InlineEditor({ item, onClose }: { item: WorkItem; onClose(): void }) {
  const restored = useRef(readInlineDraft(item.id)).current
  const seed = useRef(restored?.item ?? item).current
  const initial = useRef({ title: restored?.title ?? seed.title, content: restored?.content ?? seed.data.content ?? seed.data.notes ?? '' }).current
  const input = useRef({ ...initial }).current
  const change = (key: 'title' | 'content', value: string) => { input[key] = value; writeInlineDraft({ item: seed, ...input }) }
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const save = async (details = false) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await useWorkbench.getState().edit(seed.id, input.title, input.content, seed.data.updatedAt)
      forgetInlineDraft(seed.id)
      notice('内容已保存', useWorkbench.getState().snapshotUndo()); onClose()
      if (details) useWorkbench.getState().openCapture({ itemId: seed.id, source: seed.data.source })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const close = () => {
    const discard = () => { forgetInlineDraft(seed.id); onClose() }
    if (input.title !== seed.title || input.content !== (seed.data.content ?? seed.data.notes ?? '')) Alert.alert('放弃未保存的修改？', '本次输入尚未保存。', [{ text: '继续编辑', style: 'cancel' }, { text: '放弃修改', style: 'destructive', onPress: discard }])
    else discard()
  }
  return <View style={s.root}>
    {restored && <Text style={{ color: T.faint, fontSize: 11 }}>已恢复未保存的输入</Text>}
    <TextInput accessibilityLabel="展开编辑标题" returnKeyType="done" onSubmitEditing={Keyboard.dismiss} selectTextOnFocus defaultValue={initial.title} onChangeText={value => change('title', value)} maxLength={240} autoCorrect={false} spellCheck={false} style={s.title} />
    <TextInput accessibilityLabel="展开编辑正文" defaultValue={initial.content} onChangeText={value => change('content', value)} multiline textAlignVertical="top" placeholder="补充内容…" placeholderTextColor={T.faint} style={s.body} />
    {!!error && <Text accessibilityRole="alert" style={{ color: T.danger, fontSize: 12, lineHeight: 20 }}>{error}</Text>}
    <View style={s.actions}>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void save(true)} style={s.hit}><Text style={s.link}>时间与提醒</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={close} style={s.hit}><Text style={{ color: T.faint }}>收起</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void save()} style={s.hit}><Text style={s.link}>{busy ? '保存中…' : '保存修改'}</Text></Pressable>
    </View>
  </View>
}
const s = themedStyles(() => StyleSheet.create({ root: { paddingTop: 12, gap: 8 }, title: { color: T.ink, fontSize: 17, minHeight: 48, backgroundColor: T.paper, padding: 10, borderRadius: 10 }, body: { color: T.inkSoft, fontSize: 15, lineHeight: 24, minHeight: 96, backgroundColor: T.paper, padding: 10, borderRadius: 10 }, actions: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap' }, hit: { minHeight: 48, minWidth: 60, justifyContent: 'center', alignItems: 'center' }, link: { color: T.accent, fontSize: 13, fontWeight: '600' } }))
