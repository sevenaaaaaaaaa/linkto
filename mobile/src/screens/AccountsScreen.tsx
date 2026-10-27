import { useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { T, accountInitial } from '../theme'
import { useMail } from '../store/mail'
import { useTablet } from '../hooks/useTablet'

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

  const guess = (mail: string) => {
    const domain = mail.split('@')[1]?.toLowerCase() ?? ''
    if (domain.includes('gmail')) return { host: 'imap.gmail.com', port: '993', smtpHost: 'smtp.gmail.com', smtpPort: '465', smtpSecure: true }
    if (domain.includes('qq')) return { host: 'imap.qq.com', port: '993', smtpHost: 'smtp.qq.com', smtpPort: '465', smtpSecure: true }
    if (domain.includes('163')) return { host: 'imap.163.com', port: '993', smtpHost: 'smtp.163.com', smtpPort: '465', smtpSecure: true }
    if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live')) {
      return { host: 'outlook.office365.com', port: '993', smtpHost: 'smtp.office365.com', smtpPort: '587', smtpSecure: false }
    }
    if (domain.includes('icloud') || domain.includes('me.com')) {
      return { host: 'imap.mail.me.com', port: '993', smtpHost: 'smtp.mail.me.com', smtpPort: '587', smtpSecure: false }
    }
    return { host: domain ? 'imap.' + domain : '', port: '993', smtpHost: domain ? 'smtp.' + domain : '', smtpPort: '465', smtpSecure: true }
  }

  const onEmailChange = (v: string) => {
    setEmail(v)
    const g = guess(v)
    setHost(g.host)
    setPort(g.port)
    setSmtpHost(g.smtpHost)
    setSmtpPort(g.smtpPort)
    setSmtpSecure(g.smtpSecure)
  }

  const submit = async () => {
    setBusy(true)
    setErr('')
    const problem = await saveAccount({
      email, pass, host, port, secure,
      smtpHost, smtpPort, smtpSecure
    })
    setBusy(false)
    if (problem) {
      setErr(problem)
      return
    }
    const acc = useMail.getState().accounts.find(a => a.email === email.trim().toLowerCase())
    setEmail(''); setPass(''); setAdvanced(false)
    if (acc) void openAccount(acc)
  }

  return (
    <View style={s.root}>
      <View style={s.headRow}>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, isTablet && s.padWide]}>林可兔 LinkTo</Text>
          <Text style={[s.subtitle, isTablet && s.padWide]}>移动版 v0.4 · 多账户 / 文件夹 / 搜索 / HTML / 发信</Text>
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
          <Text style={s.hint}>Gmail / QQ / 163 需要应用专用密码或授权码；发信默认按服务商猜 SMTP</Text>
          <TextInput style={s.input} placeholder="邮箱地址" placeholderTextColor={T.faint} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" value={email} onChangeText={onEmailChange} />
          <TextInput style={s.input} placeholder="密码 / 授权码" placeholderTextColor={T.faint} secureTextEntry value={pass} onChangeText={setPass} />
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

          {err !== '' && <Text style={s.err}>{err}</Text>}
          <TouchableOpacity style={[s.btn, s.btnPrimary, s.btnBig, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void submit()}>
            <Text style={s.btnPrimaryText}>{busy ? '验证连接中…' : '验证并添加'}</Text>
          </TouchableOpacity>
          <Text style={s.note}>凭据存于系统钥匙串（Keychain / Keystore），不上传、不落明文。移动版当前只支持 465 隐式 TLS 发信；Outlook / iCloud 的 587 STARTTLS 请用 Mac 版发送。</Text>
        </View>
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
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
})
