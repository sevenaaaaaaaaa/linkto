import { useEffect, useRef, useState } from 'react'
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { themedStyles, T, accountInitial } from '../theme'
import { useMail } from '../store/mail'
import { useTablet } from '../hooks/useTablet'
import { ACCOUNT_PROVIDER_CHOICES, PROVIDER_PRESETS, microsoftProviderFor, presetFor } from '../providers'
import { authorizeMicrosoft, msClientId, saveMsClientId } from '../oauth/microsoft'

export function AccountsScreen() {
  const isTablet = useTablet()
  const { accounts, saveAccount, deleteAccount, openAccount, openUnified } = useMail()
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('993')
  const [secure, setSecure] = useState(true)
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('465')
  const [smtpSecure, setSmtpSecure] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [provider, setProvider] = useState<string | null>(null)
  const [msId, setMsId] = useState(''), [device, setDevice] = useState<{ code: string; url: string } | null>(null)
  const authAbort = useRef<AbortController | null>(null)
  useEffect(() => { void msClientId().then(setMsId); return () => authAbort.current?.abort() }, [])
  const preset = provider ? PROVIDER_PRESETS.find(p => p.key === provider)! : presetFor(email)
  const microsoft = preset.auth === 'oauth-ms'
  const proton = preset.key === 'proton'

  const onEmailChange = (v: string) => {
    setEmail(v)
    const p = provider ? PROVIDER_PRESETS.find(p => p.key === provider)! : presetFor(v)
    setHost(p.imap?.host ?? '')
    setPort(String(p.imap?.port ?? 993))
    setSecure(p.imap?.secure ?? true)
    setSmtpHost(p.smtp?.host ?? '')
    setSmtpPort(String(p.smtp?.port ?? 465))
    setSmtpSecure(p.smtp?.secure ?? true)
  }
  const oauth = async () => {
    setBusy(true); setErr(''); setDevice(null)
    const controller = new AbortController(); authAbort.current = controller
    try {
      await saveMsClientId(msId)
      const tokens = await authorizeMicrosoft((code, url) => setDevice({ code, url }), controller.signal)
      const selected = PROVIDER_PRESETS.find(p => p.key === microsoftProviderFor(tokens.email, tokens.tenantId))!
      const problem = await saveAccount({ email: tokens.email, pass: JSON.stringify(tokens), host: selected.imap!.host, port: String(selected.imap!.port), secure: true, smtpHost: selected.smtp!.host, smtpPort: String(selected.smtp!.port), smtpSecure: selected.smtp!.secure, authType: 'oauth-ms', accessToken: tokens.accessToken })
      if (problem) throw new Error(problem)
      await openUnified()
    } catch (e) { if (!controller.signal.aborted) setErr(e instanceof Error ? e.message : String(e)) }
    finally { if (!controller.signal.aborted) { setBusy(false); setDevice(null) } }
  }

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      const problem = await saveAccount({ email, pass, host, port, secure, smtpHost, smtpPort, smtpSecure })
      if (problem) { setErr(problem); return }
      const acc = useMail.getState().accounts.find(a => a.email === email.trim().toLowerCase())
      setEmail(''); setPass(''); setAdvanced(false)
      if (acc) await openAccount(acc)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <View style={s.root}>
      <View style={s.headRow}>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, isTablet && s.padWide]}>林可兔 LinkTo</Text>
          <Text style={[s.subtitle, isTablet && s.padWide]}>邮件、今日安排与随手记 · 邮箱凭据留在自己的设备</Text>
        </View>
        {accounts.length > 0 && (
          <TouchableOpacity onPress={() => void openUnified()} hitSlop={10}>
            <Text style={s.topAction}>收件箱 ›</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={[s.scrollPad, isTablet && s.scrollWide]} keyboardShouldPersistTaps="handled">
        {accounts.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>账户</Text>
            {accounts.map(a => (
              <View key={a.id} style={s.card}>
                <View style={[s.avatar, { backgroundColor: a.color }]}><Text style={s.avatarText}>{accountInitial(a.email)}</Text></View>
                <View style={s.cardBody}>
                  <Text style={s.accountEmail} numberOfLines={1}>{a.email}</Text>
                  <Text style={s.accountHost} numberOfLines={1}>{a.host}:{a.port} · SMTP {a.smtpHost}:{a.smtpPort}</Text>
                </View>
                <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={() => void openAccount(a)}>
                  <Text style={s.btnPrimaryText}>打开</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.btn, s.btnGhost]}
                  onPress={() => Alert.alert('删除账户', '会同时删除钥匙串凭据。确定删除 ' + a.email + '？', [
                    { text: '取消', style: 'cancel' },
                    { text: '删除', style: 'destructive', onPress: () => void deleteAccount(a.id) }
                  ])}
                >
                  <Text style={s.btnGhostText}>删除</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <View style={s.section}>
          <Text style={s.sectionTitle}>{accounts.length ? '添加另一个账户' : '添加 IMAP 账户'}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 14 }}>{ACCOUNT_PROVIDER_CHOICES.map(p => <Pressable accessibilityRole="button" key={p.key} onPress={() => { setProvider(p.key); if (p.imap) { setHost(p.imap.host); setPort(String(p.imap.port)); setSecure(p.imap.secure) } else setHost(''); if (p.smtp) { setSmtpHost(p.smtp.host); setSmtpPort(String(p.smtp.port)); setSmtpSecure(p.smtp.secure) } else setSmtpHost('') }} style={[s.providerChip, preset.key === p.key && { borderColor: T.accent, backgroundColor: T.accentSoft }]}><Text style={s.checkText}>{p.label}</Text></Pressable>)}</ScrollView>
          <Pressable accessibilityRole="button" onPress={() => { setProvider(null); setErr('') }} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={s.advancedText}>按邮箱地址自动识别</Text></Pressable>
          <Text style={s.hint}>{preset.hint}</Text>
          {proton ? <View style={s.providerNotice}><Text style={s.hint}>Proton Bridge 只在电脑上运行。手机端暂不能直接接入 Proton；可先使用其他邮箱同步待办与笔记。</Text><Pressable accessibilityRole="button" onPress={() => void Linking.openURL('https://proton.me/mail/download')} style={s.btn}><Text style={s.advancedText}>打开 Proton 官方移动端入口 ↗</Text></Pressable></View> : microsoft ? <View style={s.providerNotice}>
            <Text style={s.hint}>Outlook / Hotmail / Live / Microsoft 365 统一浏览器授权。首次填写自己的公共客户端应用 ID，之后可复用；个人邮箱需在 Outlook 网页版开启 IMAP。</Text>
            <TextInput accessibilityLabel="Microsoft 客户端 ID" value={msId} onChangeText={setMsId} placeholder="Microsoft Client ID（可与电脑共用）" placeholderTextColor={T.faint} autoCapitalize="none" style={s.input} />
            {device && <><Text selectable style={[s.title, { textAlign: 'center', marginBottom: 12 }]}>{device.code}</Text><Pressable accessibilityRole="button" onPress={() => void Linking.openURL(device.url)} style={s.btn}><Text style={s.advancedText}>打开微软页面并输入此代码</Text></Pressable></>}
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void oauth()} style={[s.btn, s.btnPrimary, busy && { opacity: 0.5 }]}><Text style={s.btnPrimaryText}>{busy ? '等待浏览器授权…' : '使用 Microsoft 登录'}</Text></Pressable>
          </View> : <>
          <TextInput style={s.input} placeholder="邮箱地址" placeholderTextColor={T.faint} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" value={email} onChangeText={onEmailChange} />
          <TextInput style={s.input} placeholder={preset.passwordLabel ?? '密码 / 授权码'} placeholderTextColor={T.faint} secureTextEntry value={pass} onChangeText={setPass} />
          <View style={s.row}>
            <TextInput style={[s.input, s.grow]} placeholder="IMAP 服务器" placeholderTextColor={T.faint} autoCapitalize="none" autoCorrect={false} value={host} onChangeText={setHost} />
            <TextInput style={[s.input, s.port]} placeholder="993" placeholderTextColor={T.faint} keyboardType="number-pad" value={port} onChangeText={setPort} />
          </View>
          <TouchableOpacity style={s.checkRow} onPress={() => setSecure(!secure)}>
            <View style={[s.checkbox, secure && s.checkboxOn]} />
            <Text style={s.checkText}>IMAP SSL/TLS（993）</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.advancedToggle} onPress={() => setAdvanced(v => !v)}>
            <Text style={s.advancedText}>发信服务器（SMTP）{advanced ? '▾' : '▸'}</Text>
          </TouchableOpacity>
          {advanced && (
            <>
              <View style={s.row}>
                <TextInput style={[s.input, s.grow]} placeholder="SMTP 服务器" placeholderTextColor={T.faint} autoCapitalize="none" value={smtpHost} onChangeText={setSmtpHost} />
                <TextInput style={[s.input, s.port]} placeholder="465" placeholderTextColor={T.faint} keyboardType="number-pad" value={smtpPort} onChangeText={setSmtpPort} />
              </View>
              <TouchableOpacity style={s.checkRow} onPress={() => setSmtpSecure(!smtpSecure)}>
                <View style={[s.checkbox, smtpSecure && s.checkboxOn]} />
                <Text style={s.checkText}>SMTP 隐式 TLS（465）</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity style={[s.btn, s.btnPrimary, s.btnBig, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void submit()}>
            <Text style={s.btnPrimaryText}>{busy ? '验证连接中…' : '验证并添加'}</Text>
          </TouchableOpacity>
          </>}
          {err !== '' && <Text accessibilityRole="alert" style={s.err}>{err}</Text>}
          <Text style={s.note}>凭据存于系统钥匙串。支持 465 TLS 与 587 STARTTLS；客户端授权码、API Key 或浏览器授权按服务商要求选择。</Text>
        </View>
      </ScrollView>
    </View>
  )
}

const s = themedStyles(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  headRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 20, paddingTop: 16 },
  title: { fontSize: 24, fontWeight: '700', color: T.ink },
  subtitle: { fontSize: 12, color: T.faint, marginTop: 4, lineHeight: 17 },
  topAction: { fontSize: 13, color: T.accent, fontWeight: '600', paddingBottom: 4 },
  scroll: { flex: 1 },
  scrollPad: { paddingHorizontal: 20, paddingBottom: 40 },
  scrollWide: { alignSelf: 'center', width: '100%', maxWidth: 640 },
  padWide: { alignSelf: 'center', width: '100%', maxWidth: 640 },
  section: { marginTop: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: T.ink, marginBottom: 10 },
  hint: { fontSize: 11, color: T.faint, marginBottom: 10, lineHeight: 16 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderRadius: 14, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, marginBottom: 10, gap: 8 },
  avatar: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  cardBody: { flex: 1 },
  accountEmail: { fontSize: 13, fontWeight: '600', color: T.ink },
  accountHost: { fontSize: 10, color: T.faint, marginTop: 2 },
  row: { flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
  port: { width: 80 },
  input: { backgroundColor: T.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: T.ink, marginBottom: 10 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  checkbox: { width: 16, height: 16, borderRadius: 4, borderWidth: 1.5, borderColor: T.hairline },
  checkboxOn: { backgroundColor: T.accent, borderColor: T.accent },
  checkText: { fontSize: 12, color: T.ink },
  advancedToggle: { paddingVertical: 2, marginBottom: 10 },
  advancedText: { fontSize: 12, color: T.accent, fontWeight: '500' },
  err: { fontSize: 12, color: T.danger, marginBottom: 10, lineHeight: 17 },
  btn: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' },
  btnBig: { paddingVertical: 13 },
  btnPrimary: { backgroundColor: T.accent },
  btnPrimaryText: { color: T.accentInk, fontSize: 14, fontWeight: '600' },
  btnGhost: { backgroundColor: 'rgba(31,34,38,0.06)' },
  btnGhostText: { color: T.faint, fontSize: 12 },
  note: { fontSize: 11, color: T.faint, marginTop: 10, lineHeight: 16 }
  ,providerChip: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: T.hairline, backgroundColor: T.surface }, providerNotice: { padding: 14, gap: 12, borderRadius: 14, backgroundColor: T.surfaceAlt }
}))
