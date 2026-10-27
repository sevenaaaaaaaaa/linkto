import { useEffect, useState } from 'react'
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View
} from 'react-native'
import { T, fmtShortDate } from '../theme'
import { addVaultItem, listVault, removeVaultItem, revealVaultItem, type VaultItem, type VaultItemMeta, type VaultKind } from '../vault/store'
import { copyWithClear } from '../ui/clipboard'
import { linkToCore } from '../native/LinkToCore'

export function VaultScreen() {
  const [tab, setTab] = useState<VaultKind>('note')
  const [items, setItems] = useState<VaultItemMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [revealed, setRevealed] = useState<VaultItem | null>(null)
  const [note, setNote] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      setItems(await listVault())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const save = async () => {
    if (!body.trim()) { setError('内容不能为空'); return }
    setSaving(true); setError('')
    try {
      await addVaultItem({ kind: tab, title, body })
      setAdding(false); setTitle(''); setBody('')
      await load()
      void linkToCore.haptic('medium')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const open = async (id: string) => {
    try {
      const item = await revealVaultItem(id)
      if (item) setRevealed(item)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = (item: { id: string; title: string }) => {
    Alert.alert('删除条目', '删除后无法恢复。确定删除「' + item.title + '」？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: async () => {
          try {
            await removeVaultItem(item.id)
            setRevealed(null)
            await load()
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          }
        }
      }
    ])
  }

  const share = async (item: VaultItem) => {
    try {
      await Share.share({ message: '# ' + item.title + '\n\n' + item.body })
    } catch { /* ignore */ }
  }

  const shown = items.filter(i => i.kind === tab)

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>保险箱</Text>
          <Text style={s.sub}>暂存与密码 · 系统钥匙串 + AES-GCM</Text>
        </View>
        <Pressable onPress={() => { setAdding(true); setError('') }} style={s.addBtn}>
          <Text style={s.addText}>＋</Text>
        </Pressable>
      </View>
      <View style={s.seg}>
        <Pressable onPress={() => setTab('note')} style={[s.segItem, tab === 'note' && s.segOn]}>
          <Text style={[s.segText, tab === 'note' && s.segTextOn]}>暂存</Text>
        </Pressable>
        <Pressable onPress={() => setTab('secret')} style={[s.segItem, tab === 'secret' && s.segOn]}>
          <Text style={[s.segText, tab === 'secret' && s.segTextOn]}>保险箱</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={T.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={s.body}>
          {!!error && <Text style={s.error}>{error}</Text>}
          {!shown.length && (
            <View style={s.empty}>
              <Text style={s.emptyGlyph}>{tab === 'secret' ? '▣' : '▤'}</Text>
              <Text style={s.emptyTitle}>{tab === 'secret' ? '保险箱是空的' : '还没有暂存'}</Text>
              <Text style={s.emptyText}>{tab === 'secret' ? '密码、恢复码放这里；列表不显示正文。' : '邮件、密信里值得留一段的内容，先放这里。'}</Text>
            </View>
          )}
          {shown.map(item => (
            <Pressable key={item.id} onPress={() => void open(item.id)} style={({ pressed }) => [s.row, pressed && { backgroundColor: T.accentSoft }]}>
              <View style={[s.kindBadge, item.kind === 'secret' && { backgroundColor: T.warnSoft }]}>
                <Text style={[s.kindText, item.kind === 'secret' && { color: T.warn }]}>{item.kind === 'secret' ? '密' : '记'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.itemTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={s.itemPreview} numberOfLines={1}>{item.kind === 'secret' ? '••••••  点击查看' : (item.preview || '（空）')}</Text>
              </View>
              <Text style={s.itemDate}>{fmtShortDate(item.updatedAt)}</Text>
            </Pressable>
          ))}
          <Text style={s.foot}>不同步到 Mac；条目整体加密。复制 45 秒后自动清空剪贴板。</Text>
        </ScrollView>
      )}

      <Modal visible={adding} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAdding(false)}>
        <KeyboardAvoidingView style={s.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={s.modalHead}>
            <Pressable onPress={() => setAdding(false)} hitSlop={10}><Text style={s.cancel}>取消</Text></Pressable>
            <Text style={s.modalTitle}>{tab === 'secret' ? '存入保险箱' : '新建暂存'}</Text>
            <Pressable onPress={() => void save()} disabled={saving} hitSlop={10}>
              <Text style={[s.done, saving && { opacity: 0.4 }]}>{saving ? '保存中…' : '保存'}</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={s.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={s.label}>标题</Text>
            <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder={tab === 'secret' ? '例如：GitHub 恢复码' : '例如：一段值得留的邮件'} placeholderTextColor={T.faint} />
            <Text style={s.label}>内容</Text>
            <TextInput style={[s.input, s.bodyInput]} value={body} onChangeText={setBody} placeholder="正文只存密文" placeholderTextColor={T.faint} multiline textAlignVertical="top" secureTextEntry={tab === 'secret'} />
            {!!error && <Text style={s.error}>{error}</Text>}
            <Text style={s.modalNote}>{tab === 'secret' ? '保险箱条目不会出现在列表预览里，也不会被发送到 Litmus。' : '暂存可以分享为 Markdown；密码请用保险箱。'}</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={!!revealed} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setRevealed(null)}>
        <View style={s.modalRoot}>
          <View style={s.modalHead}>
            <Pressable onPress={() => setRevealed(null)} hitSlop={10}><Text style={s.cancel}>关闭</Text></Pressable>
            <Text style={s.modalTitle} numberOfLines={1}>{revealed?.title ?? ''}</Text>
            <Pressable onPress={() => revealed && del(revealed)} hitSlop={10}><Text style={s.delete}>删除</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={s.modalBody}>
            <Text selectable style={s.revealBody}>{revealed?.body ?? ''}</Text>
            <Text style={s.modalNote}>{fmtShortDate(revealed?.updatedAt ?? 0)} · 仅本机解密</Text>
            <View style={s.revealActions}>
              <Pressable onPress={() => { if (revealed) { copyWithClear(revealed.body); setNote('已复制，45 秒后清除') } }} style={s.smallBtn}><Text style={s.smallText}>复制</Text></Pressable>
              <Pressable onPress={() => revealed && void share(revealed)} style={s.smallBtn}><Text style={s.smallText}>分享 Markdown</Text></Pressable>
            </View>
            {!!note && <Text style={s.modalNote}>{note}</Text>}
          </ScrollView>
        </View>
      </Modal>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  title: { fontSize: 22, fontWeight: '700', color: T.ink },
  sub: { fontSize: 11, color: T.faint, marginTop: 3 },
  addBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' },
  addText: { color: T.accentInk, fontSize: 22, marginTop: -2 },
  seg: { flexDirection: 'row', marginHorizontal: 20, backgroundColor: T.surfaceAlt, borderRadius: 10, padding: 3, marginBottom: 4 },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8 },
  segOn: { backgroundColor: T.surface },
  segText: { fontSize: 12, color: T.faint },
  segTextOn: { color: T.ink, fontWeight: '600' },
  body: { maxWidth: 720, width: '100%', alignSelf: 'center', padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, backgroundColor: T.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, marginBottom: 8 },
  kindBadge: { width: 30, height: 30, borderRadius: 9, backgroundColor: T.accentSoft, alignItems: 'center', justifyContent: 'center' },
  kindText: { fontSize: 12, color: T.accent, fontWeight: '700' },
  itemTitle: { fontSize: 14, color: T.ink, fontWeight: '600' },
  itemPreview: { fontSize: 11, color: T.faint, marginTop: 2 },
  itemDate: { fontSize: 9, color: T.faint },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 30 },
  emptyGlyph: { fontSize: 34, color: T.hairline },
  emptyTitle: { fontSize: 15, color: T.ink, fontWeight: '600', marginTop: 12 },
  emptyText: { fontSize: 12, color: T.faint, marginTop: 6, textAlign: 'center', lineHeight: 18 },
  foot: { fontSize: 10, color: T.faint, lineHeight: 16, marginTop: 16, textAlign: 'center' },
  error: { fontSize: 12, color: T.danger, lineHeight: 18, marginBottom: 8 },
  modalRoot: { flex: 1, backgroundColor: T.paper },
  modalHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  cancel: { fontSize: 14, color: T.accent, width: 64 },
  modalTitle: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600', color: T.ink },
  done: { fontSize: 14, color: T.accent, fontWeight: '700', width: 72, textAlign: 'right' },
  delete: { fontSize: 12, color: T.danger, width: 64, textAlign: 'right' },
  modalBody: { padding: 20, paddingBottom: 40 },
  label: { fontSize: 11, color: T.faint, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: T.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, color: T.ink },
  bodyInput: { minHeight: 220, lineHeight: 22 },
  modalNote: { fontSize: 10, color: T.faint, lineHeight: 16, marginTop: 14 },
  revealBody: { fontSize: 15, lineHeight: 25, color: T.ink },
  revealActions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  smallBtn: { backgroundColor: T.surfaceAlt, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  smallText: { fontSize: 11, color: T.inkSoft, fontWeight: '500' }
})
