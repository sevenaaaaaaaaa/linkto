import { useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { T } from '../theme'
import { useMail } from '../store/mail'
import { useTablet } from '../hooks/useTablet'

export function AccountsScreen() {
  const isTablet = useTablet()
  const { accounts, saveAccount, deleteAccount, openInbox } = useMail()
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('993')
  const [secure, setSecure] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const guessHost = (mail: string) => {
    const domain = mail.split('@')[1]?.toLowerCase() ?? ''
    if (domain.includes('gmail')) return { host: 'imap.gmail.com', port: '993' }
    if (domain.includes('qq')) return { host: 'imap.qq.com', port: '993' }
    if (domain.includes('163')) return { host: 'imap.163.com', port: '993' }
    if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live')) return { host: 'outlook.office365.com', port: '993' }
    if (domain.includes('icloud')) return { host: 'imap.mail.me.com', port: '993' }
    return { host: `imap.${domain}`, port: '993' }
  }

  const onEmailChange = (v: string) => {
    setEmail(v)
    const g = guessHost(v)
    setHost(g.host)
    setPort(g.port)
  }

  const submit = async () => {
    setBusy(true)
    setErr('')
    const problem = await saveAccount({ email, pass, host, port, secure })
    setBusy(false)
    if (problem) setErr(problem)
    else {
      setEmail(''); setPass('')
      const acc = useMail.getState().accounts.find(a => a.email === email.trim().toLowerCase())
      if (acc) void openInbox(acc)
    }
  }

  return (
    <SafeAreaView style={s.root}>
      <Text style={[s.title, isTablet && s.padWide]}>林可兔 LinkTo</Text>
      <Text style={[s.subtitle, isTablet && s.padWide]}>AI 原生邮件工作台 · 移动版 v0.3（原生安全内核）</Text>

      <ScrollView style={s.scroll} contentContainerStyle={[s.scrollPad, isTablet && s.scrollWide]}>
        {accounts.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>已添加账户</Text>
            {accounts.map(a => (
              <View key={a.id} style={s.card}>
                <View style={s.cardBody}>
                  <Text style={s.accountEmail}>{a.email}</Text>
                  <Text style={s.accountHost}>{a.host}:{a.port}{a.secure ? ' SSL' : ''}</Text>
                </View>
                <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={() => void openInbox(a)}>
                  <Text style={s.btnPrimaryText}>收信</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => void deleteAccount(a.id)}>
                  <Text style={s.btnGhostText}>删除</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <View style={s.section}>
          <Text style={s.sectionTitle}>添加 IMAP 账户</Text>
          <Text style={s.hint}>Gmail / QQ / 163 需要应用专用密码或授权码</Text>
          <TextInput style={s.input} placeholder="邮箱地址" placeholderTextColor={T.faint} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" value={email} onChangeText={onEmailChange} />
          <TextInput style={s.input} placeholder="密码 / 授权码" placeholderTextColor={T.faint} secureTextEntry value={pass} onChangeText={setPass} />
          <View style={s.row}>
            <TextInput style={[s.input, s.grow]} placeholder="IMAP 服务器" placeholderTextColor={T.faint} autoCapitalize="none" value={host} onChangeText={setHost} />
            <TextInput style={[s.input, s.port]} placeholder="993" placeholderTextColor={T.faint} keyboardType="number-pad" value={port} onChangeText={setPort} />
          </View>
          <TouchableOpacity style={s.checkRow} onPress={() => setSecure(!secure)}>
            <View style={[s.checkbox, secure && s.checkboxOn]} />
            <Text style={s.checkText}>SSL/TLS 加密（993 端口）</Text>
          </TouchableOpacity>
          {err !== '' && <Text style={s.err}>{err}</Text>}
          <TouchableOpacity style={[s.btn, s.btnPrimary, s.btnBig, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void submit()}>
            <Text style={s.btnPrimaryText}>{busy ? '验证连接中…' : '验证并添加'}</Text>
          </TouchableOpacity>
          <Text style={s.note}>凭据存于系统钥匙串（Keychain / Keystore），不上传、不落明文</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  title: { fontSize: 24, fontWeight: '700', color: T.ink, paddingHorizontal: 20, paddingTop: 16 },
  subtitle: { fontSize: 12, color: T.faint, paddingHorizontal: 20, marginTop: 4 },
  scroll: { flex: 1 },
  scrollPad: { paddingHorizontal: 20, paddingBottom: 40 },
  scrollWide: { alignSelf: 'center', width: '100%', maxWidth: 640 },
  padWide: { alignSelf: 'center', width: '100%', maxWidth: 640 },
  section: { marginTop: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: T.ink, marginBottom: 10 },
  hint: { fontSize: 11, color: T.faint, marginBottom: 10 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderRadius: 14, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, marginBottom: 10, gap: 8 },
  cardBody: { flex: 1 },
  accountEmail: { fontSize: 14, fontWeight: '600', color: T.ink },
  accountHost: { fontSize: 11, color: T.faint, marginTop: 2 },
  row: { flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
  port: { width: 80 },
  input: { backgroundColor: T.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: T.ink, marginBottom: 10 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  checkbox: { width: 16, height: 16, borderRadius: 4, borderWidth: 1.5, borderColor: T.hairline },
  checkboxOn: { backgroundColor: T.accent, borderColor: T.accent },
  checkText: { fontSize: 12, color: T.ink },
  err: { fontSize: 12, color: T.danger, marginBottom: 10 },
  btn: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' },
  btnBig: { paddingVertical: 13 },
  btnPrimary: { backgroundColor: T.accent },
  btnPrimaryText: { color: T.accentInk, fontSize: 14, fontWeight: '600' },
  btnGhost: { backgroundColor: 'rgba(31,34,38,0.06)' },
  btnGhostText: { color: T.faint, fontSize: 12 },
  note: { fontSize: 11, color: T.faint, marginTop: 10, lineHeight: 16 }
})