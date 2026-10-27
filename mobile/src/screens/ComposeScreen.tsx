import { useState } from 'react'
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { T } from '../theme'
import { useMail } from '../store/mail'
import { aiDraftReply } from '../ai/client'

export function ComposeScreen() {
  const { compose, accounts, sending, composeError, updateCompose, sendCompose, closeCompose, reading } = useMail()
  const [showCc, setShowCc] = useState(!!compose?.cc)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  if (!compose) return null

  const draftAI = async () => {
    setAiBusy(true); setAiError('')
    try {
      const draft = await aiDraftReply({ subject: compose.subject || '（无主题）', from: compose.to || '收件人', text: compose.body || '（还没有正文，请根据主题起草）' })
      updateCompose({ body: draft })
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e))
    } finally {
      setAiBusy(false)
    }
  }
  const account = accounts.find(a => a.id === compose.accountId) ?? accounts[0]

  return (
    <SafeAreaView style={s.root} edges={['bottom', 'left', 'right']}>
      <View style={s.header}>
        <Pressable onPress={closeCompose} hitSlop={10}><Text style={s.cancel}>取消</Text></Pressable>
        <Text style={s.title}>{reading ? '回复' : '新邮件'}</Text>
        <Pressable onPress={() => void sendCompose()} disabled={sending} hitSlop={10}>
          <Text style={[s.send, sending && { opacity: 0.4 }]}>{sending ? '发送中…' : '发送'}</Text>
        </Pressable>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>发件账户</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
            {accounts.map(a => (
              <Pressable
                key={a.id}
                onPress={() => updateCompose({ accountId: a.id })}
                style={[s.chip, a.id === compose.accountId && s.chipOn]}
              >
                <View style={[s.chipDot, { backgroundColor: a.color }]} />
                <Text style={[s.chipText, a.id === compose.accountId && s.chipTextOn]} numberOfLines={1}>{a.email}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={s.label}>收件人</Text>
          <TextInput
            style={s.input}
            value={compose.to}
            onChangeText={to => updateCompose({ to })}
            placeholder="name@example.com，多个用逗号分隔"
            placeholderTextColor={T.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          {!showCc ? (
            <Pressable onPress={() => setShowCc(true)} hitSlop={8}><Text style={s.ccToggle}>添加抄送 / 密送</Text></Pressable>
          ) : (
            <>
              <Text style={s.label}>抄送</Text>
              <TextInput
                style={s.input}
                value={compose.cc}
                onChangeText={cc => updateCompose({ cc })}
                placeholder="cc@example.com"
                placeholderTextColor={T.faint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
            </>
          )}
          <Text style={s.label}>主题</Text>
          <TextInput
            style={s.input}
            value={compose.subject}
            onChangeText={subject => updateCompose({ subject })}
            placeholder="主题"
            placeholderTextColor={T.faint}
          />
          <View style={s.bodyHead}>
            <Text style={[s.label, { marginTop: 0, marginBottom: 0 }]}>正文</Text>
            <Pressable onPress={() => void draftAI()} disabled={aiBusy} hitSlop={8}>
              <Text style={[s.aiBtn, aiBusy && { opacity: 0.4 }]}>{aiBusy ? 'AI 起草中…' : 'AI 起草'}</Text>
            </Pressable>
          </View>
          <TextInput
            style={[s.input, s.bodyInput]}
            value={compose.body}
            onChangeText={body => updateCompose({ body })}
            placeholder="写点什么…"
            placeholderTextColor={T.faint}
            multiline
            textAlignVertical="top"
            autoCapitalize="sentences"
          />
          {!!aiError && <Text style={s.error}>{aiError}</Text>}
          {!!composeError && <Text style={s.error}>{composeError}</Text>}
          {!account?.smtpSecure && (
            <Text style={s.warn}>这个账户的 SMTP 是 587 STARTTLS；移动版当前只支持 465 隐式 TLS，发信会失败。可以先在 Mac 上发送。</Text>
          )}
          <View style={s.footer}>
            <Text style={s.footerText}>纯文本 · 附件下一轮支持</Text>
            {sending && <ActivityIndicator size="small" color={T.accent} />}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  cancel: { fontSize: 14, color: T.accent, width: 52 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: T.ink, textAlign: 'center' },
  send: { fontSize: 14, color: T.accent, fontWeight: '700', width: 72, textAlign: 'right' },
  body: { maxWidth: 720, width: '100%', alignSelf: 'center', padding: 18, paddingBottom: 40 },
  label: { fontSize: 11, color: T.faint, marginTop: 12, marginBottom: 5 },
  bodyHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, marginBottom: 5 },
  aiBtn: { fontSize: 11, color: T.accent, fontWeight: '600' },
  chips: { gap: 8, paddingVertical: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, backgroundColor: T.surface, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20, maxWidth: 220 },
  chipOn: { borderColor: T.accent, backgroundColor: T.accentSoft },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { fontSize: 11, color: T.faint },
  chipTextOn: { color: T.ink, fontWeight: '500' },
  input: { backgroundColor: T.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, borderRadius: 11, paddingHorizontal: 13, paddingVertical: 11, fontSize: 15, color: T.ink },
  bodyInput: { minHeight: 220, lineHeight: 23 },
  ccToggle: { fontSize: 12, color: T.accent, marginTop: 8 },
  error: { marginTop: 12, fontSize: 12, color: T.danger, lineHeight: 18 },
  warn: { marginTop: 12, fontSize: 11, color: T.warn, lineHeight: 17 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  footerText: { fontSize: 11, color: T.faint }
})
