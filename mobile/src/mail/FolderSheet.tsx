import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useMail, type MobileMessage } from '../store/mail'
import { T, themedStyles } from '../theme'
import { notice } from '../ui/Notice'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { messageKey } from '../mail-cache'
import { protectedMailbox } from '../imap/mailbox-name'

export function FolderSheet({ accountId, messages, onClose }: { accountId: string; messages?: MobileMessage[]; onClose(): void }) {
  const { folders, accounts, reloadFolders, changeFolder, moveToFolder } = useMail()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [name, setName] = useState(''), [renaming, setRenaming] = useState<string | null>(null)
  const reduced = useReducedMotion(), moving = !!messages
  const completed = useRef(new Set<string>()), scroll = useRef<ComponentRef<typeof ScrollView>>(null)
  const allUndos = useRef<Array<() => Promise<void>>>([])
  const created = useRef(new Set<string>()), operation = useRef(false)
  useEffect(() => { void reloadFolders(accountId).catch(e => setError(String(e))) }, [accountId, reloadFolders])
  const run = async (fn: () => Promise<void>) => { if (operation.current) return; operation.current = true; setBusy(true); setError(''); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { operation.current = false; setBusy(false) } }
  const performMove = async (target: string) => {
    let count = 0
    try {
      for (const message of messages ?? []) {
        if (message.mailbox === target || completed.current.has(messageKey(message))) continue
        const result = await moveToFolder(message, target); completed.current.add(messageKey(message)); if (result.undo) allUndos.current.push(result.undo); count++
      }
      onClose()
    } finally {
      const pending = [...allUndos.current].reverse()
      if (count) notice(`已移动 ${completed.current.size} 封邮件`, pending.length ? async () => { while (pending.length) { await pending[0](); pending.shift() } } : undefined)
    }
  }
  const move = (target: string) => void run(() => performMove(target))
  const createAndMove = () => void run(async () => {
    const target = name.trim()
    if (!created.current.has(target)) { await changeFolder(accountId, 'create', target); created.current.add(target) }
    await performMove(target)
  })
  const edit = () => void run(async () => { await changeFolder(accountId, renaming ? 'rename' : 'create', renaming ?? name, renaming ? name : undefined); setName(''); setRenaming(null); notice(renaming ? '文件夹已改名' : '文件夹已新建') })
  const remove = (folder: string) => Alert.alert('删除空文件夹？', `“${folder}”将从服务器删除，其他设备也会更新。只允许空文件夹；此操作不能撤销。`, [{ text: '取消', style: 'cancel' }, { text: '删除空文件夹', style: 'destructive', onPress: () => void run(async () => { await changeFolder(accountId, 'delete', folder); notice('空文件夹已删除') }) }])
  return <Modal visible presentationStyle="pageSheet" animationType={reduced ? 'none' : 'slide'} onRequestClose={() => { if (!busy) onClose() }}><SafeAreaView style={s.root}>
    <View style={s.header}><Text style={s.title}>{moving ? '移动到文件夹' : '管理文件夹'}</Text><Pressable accessibilityRole="button" disabled={busy} onPress={onClose} style={s.hit}><Text style={s.link}>完成</Text></Pressable></View>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={s.body}>
      <Text style={s.hint}>{accounts.find(a => a.id === accountId)?.email}{moving ? ` · ${messages?.length} 封邮件` : ' · 与邮箱服务器同步'}</Text>
      <View style={s.editor}><Text style={s.hint}>{moving ? '新建目标文件夹并移入' : renaming ? `改名：${renaming}` : '新建文件夹'}</Text><TextInput accessibilityLabel="文件夹名称" editable={!busy} value={name} onChangeText={setName} maxLength={180} placeholder="例如：项目跟进" placeholderTextColor={T.faint} autoCorrect={false} style={s.input} /><View style={{ flexDirection: 'row', gap: 18 }}><Pressable accessibilityRole="button" disabled={busy || !name.trim()} onPress={moving ? createAndMove : edit} style={s.hit}><Text style={s.link}>{moving ? '新建并移入' : renaming ? '保存名称' : '新建文件夹'}</Text></Pressable>{renaming && <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setRenaming(null); setName('') }} style={s.hit}><Text style={s.link}>取消改名</Text></Pressable>}</View></View>
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      {busy && <Text accessibilityLiveRegion="polite" style={s.hint}>正在与服务器更新，请稍候…</Text>}
      {(folders[accountId] ?? []).map(folder => <View key={folder.name} style={s.row}>
        <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={`${moving ? '移动到' : '打开'}文件夹 ${folder.name}`} onPress={() => moving ? move(folder.name) : void run(async () => { const account = accounts.find(a => a.id === accountId); if (account) await useMail.getState().openFolder(account, folder.name); onClose() })} style={{ flex: 1, minHeight: 52, justifyContent: 'center' }}><Text numberOfLines={2} style={s.folder}>{folder.name}</Text></Pressable>
        {!moving && !protectedMailbox(folder) && <><Pressable accessibilityRole="button" accessibilityLabel={`改名文件夹 ${folder.name}`} disabled={busy} onPress={() => { setRenaming(folder.name); setName(folder.name); scroll.current?.scrollTo({ y: 0, animated: !reduced }) }} style={s.hit}><Text style={s.link}>改名</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`删除空文件夹 ${folder.name}`} disabled={busy} onPress={() => remove(folder.name)} style={s.hit}><Text style={{ color: T.danger, fontSize: 12 }}>删除</Text></Pressable></>}
      </View>)}
      {!moving && <Text style={s.hint}>系统文件夹与加密同步文件夹受保护。删除前会检查邮件与子文件夹。</Text>}
    </ScrollView>
  </SafeAreaView></Modal>
}
const s = themedStyles(() => StyleSheet.create({ root: { flex: 1, backgroundColor: T.paper }, header: { paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline }, title: { flex: 1, color: T.ink, fontSize: 20, fontWeight: '600' }, body: { padding: 20, paddingBottom: 40, maxWidth: 720, alignSelf: 'center', width: '100%', gap: 12 }, hit: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' }, link: { color: T.accent, fontSize: 13 }, hint: { color: T.faint, fontSize: 12, lineHeight: 20 }, editor: { backgroundColor: T.surface, padding: 14, borderRadius: 16 }, input: { minHeight: 48, color: T.ink, fontSize: 16 }, row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline }, folder: { color: T.ink, fontSize: 14 }, error: { color: T.danger, fontSize: 13, lineHeight: 22 } }))
