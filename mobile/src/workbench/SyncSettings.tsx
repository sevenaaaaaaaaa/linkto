import { useEffect, useState } from 'react'
import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { themedStyles, T } from '../theme'
import { useMail } from '../store/mail'
import { configureWorkSync, readSyncConfig, syncWorkbench, useWorkSync } from './sync'

export function SyncSettings() {
  const accounts = useMail(s => s.accounts)
  const state = useWorkSync()
  const [enabled, setEnabled] = useState(false), [email, setEmail] = useState(''), [pass, setPass] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { let alive = true; void readSyncConfig().then(c => { if (c && alive) { setEnabled(c.enabled); setEmail(c.accountEmail); setPass(c.passphrase) } }); return () => { alive = false } }, [])
  const save = async () => {
    setSaving(true)
    try { await configureWorkSync({ enabled, accountEmail: email, passphrase: pass }); if (!useWorkSync.getState().error) Alert.alert('同步设置已保存', enabled ? '这台设备将自动同步待办和随手记。' : '本机数据保留。') }
    catch (e) { Alert.alert('未能保存', e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }
  return <View style={s.root}>
    <View style={s.row}><View style={{ flex: 1 }}><Text style={s.title}>自己的邮箱，所有设备</Text><Text style={s.hint}>待办与随手记加密后放入隐藏文件夹 LinkTo-Sync。</Text></View><Switch accessibilityLabel="启用待办与笔记加密同步" value={enabled} onValueChange={setEnabled} /></View>
    {enabled && <>
      <Text style={s.label}>同步邮箱 · 与电脑选择同一个</Text>
      {accounts.map(a => <Pressable accessibilityRole="radio" accessibilityState={{ checked: email === a.email }} key={a.id} onPress={() => setEmail(a.email)} style={[s.account, email === a.email && { borderColor: T.accent }]}><Text style={s.email}>{a.email}</Text>{email === a.email && <Text style={s.link}>已选择</Text>}</Pressable>)}
      {!accounts.length && <Text style={s.hint}>先在邮箱账户中添加一个支持 IMAP 的同步邮箱。</Text>}
      <TextInput accessibilityLabel="跨设备同步口令" value={pass} onChangeText={setPass} secureTextEntry placeholder="与电脑相同的同步口令" placeholderTextColor={T.faint} style={s.input} autoCapitalize="none" />
      <Text style={s.hint}>电脑端：设置 → 同步与备份 → 手机与电脑。选择同一邮箱与口令。每个朋友使用自己的邮箱与口令。</Text>
    </>}
    {!!state.error && <Text accessibilityRole="alert" style={s.error}>{state.error}</Text>}
    <View style={s.row}><Pressable accessibilityRole="button" disabled={saving} onPress={() => void save()} style={s.button}><Text style={s.buttonText}>{saving ? '保存中…' : '保存同步设置'}</Text></Pressable><Pressable accessibilityRole="button" disabled={state.busy} onPress={() => void syncWorkbench()} style={s.hit}><Text style={s.link}>{state.busy ? '同步中…' : '立即同步'}</Text></Pressable></View>
    {state.lastSync && <Text style={s.hint}>上次同步 · {new Date(state.lastSync).toLocaleTimeString('zh-CN')}</Text>}
  </View>
}
const s = themedStyles(() => StyleSheet.create({ root: { backgroundColor: T.surface, borderRadius: 18, padding: 18, gap: 14 }, row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, title: { color: T.ink, fontSize: 16, fontWeight: '600' }, hint: { color: T.faint, fontSize: 12, lineHeight: 20, marginTop: 4 }, label: { color: T.inkSoft, fontSize: 12, marginTop: 10 }, account: { borderWidth: 1, borderColor: T.hairline, borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center' }, email: { color: T.ink, flex: 1, fontSize: 13 }, link: { color: T.accent, fontSize: 13, fontWeight: '600' }, input: { minHeight: 48, padding: 12, backgroundColor: T.surfaceAlt, color: T.ink, borderRadius: 12 }, error: { color: T.danger, fontSize: 12, lineHeight: 20 }, button: { minHeight: 48, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: T.accent }, buttonText: { color: T.accentInk, fontWeight: '600' }, hit: { minHeight: 48, justifyContent: 'center' } }))
