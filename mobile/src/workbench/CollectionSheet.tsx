import { useState } from 'react'
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWorkbench } from './store'
import { T, themedStyles } from '../theme'
import { notice } from '../ui/Notice'
import { useReducedMotion } from '../hooks/useReducedMotion'

export function CollectionSheet({ ids, onChoose, onClose }: { ids?: string[]; onChoose(value: string | null): void; onClose(): void }) {
  const { items, moveCollection, renameCollection, snapshotUndo } = useWorkbench()
  const folders = [...new Set(items.filter(i => i.status !== 'dismissed').map(i => typeof i.data.collection === 'string' ? i.data.collection : '').filter(Boolean))].sort()
  const [name, setName] = useState(''), [renaming, setRenaming] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const reduced = useReducedMotion()
  const run = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); notice('文件夹已更新', snapshotUndo()); onClose() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  const choose = (folder: string | null) => { if (ids) void run(async () => { await moveCollection(ids, folder ?? ''); onChoose(folder ?? '') }); else { onChoose(folder); onClose() } }
  return <Modal visible presentationStyle="pageSheet" animationType={reduced ? 'none' : 'slide'} onRequestClose={() => { if (!busy) onClose() }}><SafeAreaView style={s.root}>
    <View style={s.header}><Text style={s.title}>{ids ? '移动到文件夹' : '待办与随手记文件夹'}</Text><Pressable accessibilityRole="button" disabled={busy} onPress={onClose} style={s.hit}><Text style={s.link}>完成</Text></Pressable></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.body}>
      <Text style={s.hint}>文件夹随内容一起加密同步。新文件夹在移入第一条内容时创建；移除文件夹会把内容放回未分组。</Text>
      {(ids || renaming) && <View style={s.editor}><TextInput accessibilityLabel="待办文件夹名称" value={name} onChangeText={setName} maxLength={64} placeholder={renaming ? '新的文件夹名称' : '新建文件夹并移入'} placeholderTextColor={T.faint} style={s.input} /><Pressable accessibilityRole="button" disabled={busy || !name.trim()} onPress={() => renaming ? void run(async () => { await renameCollection(renaming, name); onChoose(name.trim()) }) : choose(name.trim())} style={s.hit}><Text style={s.link}>{renaming ? '保存文件夹名称' : '新建并移动'}</Text></Pressable></View>}
      {!!error && <Text accessibilityRole="alert" style={{ color: T.danger }}>{error}</Text>}
      {!ids && <Pressable accessibilityRole="button" onPress={() => choose(null)} style={s.hit}><Text style={s.folder}>全部文件夹</Text></Pressable>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => choose('')} style={s.hit}><Text style={s.folder}>未分组</Text></Pressable>
      {folders.map(folder => <View key={folder} style={s.row}><Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={`选择待办文件夹 ${folder}`} onPress={() => choose(folder)} style={[s.hit, { flex: 1 }]}><Text style={s.folder}>{folder}</Text></Pressable>{!ids && <><Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={`改名待办文件夹 ${folder}`} onPress={() => { setRenaming(folder); setName(folder) }} style={s.hit}><Text style={s.link}>改名</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={`移除待办文件夹 ${folder}`} onPress={() => Alert.alert('移除文件夹？', '里面的待办和随手记会保留，并移到未分组。', [{ text: '取消', style: 'cancel' }, { text: '移除文件夹', onPress: () => void run(async () => { await renameCollection(folder, ''); onChoose(null) }) }])} style={s.hit}><Text style={{ color: T.danger, fontSize: 12 }}>移除</Text></Pressable></>}</View>)}
    </ScrollView>
  </SafeAreaView></Modal>
}
const s = themedStyles(() => StyleSheet.create({ root: { flex: 1, backgroundColor: T.paper }, header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, gap: 12 }, title: { flex: 1, color: T.ink, fontSize: 20, fontWeight: '600' }, body: { padding: 20, paddingBottom: 40, maxWidth: 720, width: '100%', alignSelf: 'center', gap: 10 }, hit: { minHeight: 48, minWidth: 48, justifyContent: 'center' }, folder: { color: T.ink, fontSize: 15 }, link: { color: T.accent, fontSize: 13 }, hint: { color: T.faint, fontSize: 12, lineHeight: 20 }, row: { flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline }, editor: { backgroundColor: T.surface, borderRadius: 14, padding: 12 }, input: { color: T.ink, minHeight: 48, fontSize: 16 } }))
