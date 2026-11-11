import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { T, themedStyles } from '../theme'
import { Icon } from '../ui/Icon'
import { Brand } from '../ui/Brand'
import { linkToCore } from '../native/LinkToCore'
import { parseBackup, unlockBackup, type BackupEnvelope, type BackupPlan } from './format'
import { applyBackup, type RestoreOptions, type RestoreReceipt } from './restore'
import { useMail } from '../store/mail'
import { useReducedMotion } from '../hooks/useReducedMotion'

export function RestoreEntry({ onboarding = false }: { onboarding?: boolean }) {
  const reducedMotion = useReducedMotion()
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [file, setFile] = useState<{ name: string; envelope: BackupEnvelope } | null>(null), [password, setPassword] = useState('')
  const [plan, setPlan] = useState<BackupPlan | null>(null), [receipt, setReceipt] = useState<RestoreReceipt | null>(null)
  const [options, setOptions] = useState<RestoreOptions>({ accounts: true, items: true, ai: false })
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const close = () => { if (busy) return; setOpen(false); setFile(null); setPlan(null); setPassword(''); setReceipt(null); setError('') }
  const pick = async () => {
    setBusy('正在打开文件…'); setError('')
    try {
      const selected = await linkToCore.pickBackup()
      if (!alive.current || !selected) return
      setFile(null); setPlan(null); setReceipt(null);
      setFile({ name: selected.name, envelope: parseBackup(selected.text) }); setPlan(null); setPassword(''); setReceipt(null)
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (alive.current) setBusy('') }
  }
  const unlock = async () => {
    if (!file || busy) return
    Keyboard.dismiss()
    setBusy('正在解密备份…'); setError('')
    try { const next = await unlockBackup(file.envelope, password); if (alive.current) { setPlan(next); setPassword(''); setOptions({ accounts: true, items: true, ai: false }) } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (alive.current) setBusy('') }
  }
  const restore = async () => {
    if (!plan || busy) return
    setBusy('正在合并恢复…'); setError('')
    try { const result = await applyBackup(plan, options); if (alive.current) { setReceipt(result); setPlan(null); setFile(null) } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (alive.current) setBusy('') }
  }
  const existing = useMail(s => s.accounts)
  const choice = (key: keyof RestoreOptions, title: string, detail: string, count: number) => <Pressable key={key} accessibilityRole="checkbox" accessibilityLabel={title} accessibilityState={{ checked: options[key], disabled: busy !== '' || !count }} disabled={!!busy || !count} onPress={() => setOptions(o => ({ ...o, [key]: !o[key] }))} style={s.choice}><View style={[s.check, options[key] && count > 0 && { backgroundColor: T.accent }]}>{options[key] && count > 0 && <Icon name="check" size={14} color={T.accentInk} />}</View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{title} · {count}</Text><Text style={s.detail}>{detail}</Text></View></Pressable>
  const canRestore = plan && ((options.accounts && plan.accounts.some(a => !a.desktopOnly)) || (options.items && plan.items.length > 0) || (options.ai && !!plan.ai))
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="从桌面备份恢复" onPress={() => setOpen(true)} style={({ pressed }) => [s.entry, onboarding && s.onboarding, pressed && { opacity: 0.7 }]}><View style={s.entryIcon}><Icon name="restore" /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>从桌面备份恢复</Text><Text style={s.detail}>{onboarding ? '已有 LinkTo？选一个 .lkbak，带回邮箱和安排' : '导入 .lkbak · 邮箱、待办、随手记与 AI 配置'}</Text></View><Icon name="chevron" size={16} color={T.faint} /></Pressable>
    <Modal visible={open} animationType={reducedMotion ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={s.root}><View style={s.header}><Text style={s.headerTitle}>恢复备份</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭恢复备份" disabled={!!busy} onPress={close} style={s.close}><Icon name="close" /></Pressable></View>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="always" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
          <Brand subtitle="把电脑上的工作，带到手机。" />
          <Text style={s.title}>{receipt ? '已经带回来了' : plan ? '选择要带回的内容' : '从一份备份继续'}</Text>
          <Text style={s.intro}>{receipt ? '本机原有内容已保留。邮件正文将在连接邮箱后重新接收。' : '支持桌面导出的 .lkbak v1 / v2。选择 iCloud Drive、「我的 iPhone」或其他文件提供方中的备份。'}</Text>
          {!receipt && <Pressable accessibilityRole="button" accessibilityLabel={file ? '重新选择备份文件' : '选择 .lkbak 备份文件'} accessibilityHint={file?.name ?? '打开系统文件选择器'} disabled={!!busy} onPress={() => void pick()} style={s.file}><Icon name="folder" /><View style={{ flex: 1 }}><Text numberOfLines={2} style={s.rowTitle}>{file?.name ?? '选择 .lkbak 备份文件'}</Text><Text style={s.detail}>{file ? '点击重新选择' : '打开系统文件选择器'}</Text></View><Icon name="chevron" size={16} /></Pressable>}
          {file && !plan && !receipt && <View style={s.panel}><Text style={s.rowTitle}>备份口令</Text><TextInput accessibilityLabel="备份口令" placeholder="导出备份时设置的口令" placeholderTextColor={T.faint} secureTextEntry autoCorrect={false} value={password} editable={!busy} onChangeText={setPassword} onSubmitEditing={() => void unlock()} style={s.input} /><Text style={s.detail}>与这台手机的主密码无关。</Text><Pressable accessibilityRole="button" disabled={!!busy || !password} onPress={() => void unlock()} style={[s.primary, (!!busy || !password) && { opacity: 0.45 }]}><Text style={s.primaryText}>解密并预览</Text></Pressable></View>}
          {plan && <>
            {plan.createdAt > 0 && <Text style={s.detail}>备份时间 · {new Date(plan.createdAt).toLocaleString('zh-CN')}</Text>}
            <View style={s.panel}>{choice('accounts', '邮箱账户', '保留服务器配置与备份中可用的应用密码，已有邮箱跳过', plan.accounts.length)}{choice('items', '待办与随手记', '合并记录，保留手机上较新的修改；提醒默认关闭', plan.items.length)}{choice('ai', 'AI 接口与模型', plan.ai ? `${plan.ai.baseUrl} · ${plan.ai.model}${plan.ai.key ? ' · 包含 API Key' : ''}` : '此备份没有可恢复的 AI 配置', plan.ai ? 1 : 0)}</View>
            {plan.accounts.length > 0 && <View style={s.panel}>{plan.accounts.map((a, i) => <View key={i} style={s.account}><Text selectable style={s.rowTitle}>{a.account.email}</Text><Text style={s.detail}>{a.desktopOnly ? a.reason : existing.some(e => e.email.toLowerCase() === a.account.email) ? '手机已存在 · 将跳过' : a.reason ?? '可恢复 · 连接后接收邮件'}</Text></View>)}</View>}
            {plan.unsupported > 0 && <Text style={s.intro}>{plan.unsupported} 项桌面专属内容暂不导入，原备份文件保持完整。</Text>}
            <Pressable accessibilityRole="button" disabled={!!busy || !canRestore} onPress={() => void restore()} style={[s.primary, (!!busy || !canRestore) && { opacity: 0.45 }]}><Text style={s.primaryText}>合并恢复所选内容</Text></Pressable>
          </>}
          {receipt && <View style={s.panel}><View style={s.success}><Icon name="check" size={24} /><Text style={s.rowTitle}>恢复完成</Text></View><Text style={s.intro}>{receipt.accounts} 个邮箱 · {receipt.items} 条待办 / 随手记{receipt.ai ? ' · AI 配置已恢复' : ''}</Text><Text style={s.detail}>{receipt.skipped} 项已有或较新的内容已跳过</Text>{receipt.pending.map(value => <Text key={value} style={s.detail}>{value}</Text>)}{receipt.desktopOnly.map(email => <Text key={email} style={s.detail}>{email} · 依赖电脑服务，未导入</Text>)}<Pressable accessibilityRole="button" onPress={() => { close(); useMail.getState().setTab('mail'); useMail.getState().go('accounts') }} style={s.primary}><Text style={s.primaryText}>查看邮箱与登录状态</Text></Pressable></View>}
          {!!error && <Text accessibilityRole="alert" selectable style={s.error}>{error}</Text>}
          {!!busy && <View style={s.success}><ActivityIndicator color={T.ink} /><Text style={s.detail}>{busy}</Text></View>}
          <View style={s.security}><Icon name="shield" size={16} color={T.faint} /><Text style={[s.detail, { flex: 1 }]}>在手机本机解密。恢复失败会撤回本次改动，原数据留在手机。</Text></View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>
}
const s = themedStyles(() => StyleSheet.create({ root: { flex: 1, backgroundColor: T.paper }, entry: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, minHeight: 80, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, borderRadius: 14, backgroundColor: T.surface }, onboarding: { marginTop: 22 }, entryIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: T.surfaceAlt, borderRadius: 10 }, rowTitle: { color: T.ink, fontSize: 15, fontWeight: '600', lineHeight: 23 }, detail: { color: T.faint, fontSize: 12, lineHeight: 20 }, header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline }, headerTitle: { color: T.ink, fontSize: 15, fontWeight: '600' }, close: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }, body: { padding: 24, paddingBottom: 48, gap: 20, maxWidth: 720, width: '100%', alignSelf: 'center' }, title: { color: T.ink, fontSize: 28, fontWeight: '700', letterSpacing: -0.8, marginTop: 12 }, intro: { color: T.inkSoft, fontSize: 14, lineHeight: 23 }, file: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 12, backgroundColor: T.surface, borderWidth: 1, borderColor: T.hairline }, panel: { backgroundColor: T.surface, borderRadius: 14, padding: 18, gap: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline }, input: { minHeight: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: T.hairline, borderRadius: 10, color: T.ink, fontSize: 16 }, primary: { minHeight: 48, padding: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: T.accent }, primaryText: { color: T.accentInk, fontSize: 15, fontWeight: '600' }, choice: { flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 64 }, check: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: T.hairline, alignItems: 'center', justifyContent: 'center' }, account: { paddingVertical: 6 }, error: { color: T.danger, fontSize: 13, lineHeight: 22 }, success: { flexDirection: 'row', alignItems: 'center', gap: 12 }, security: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 } }))
