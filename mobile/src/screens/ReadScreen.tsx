import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { T, fmtBytes, fmtShortDate, prettyFrom } from '../theme'
import { useMail } from '../store/mail'
import { wrapHtml } from '../imap/MimeLite'
import { SwipeReader, SwipeHint } from '../ui/SwipeReader'
import { addVaultItem } from '../vault/store'
import { aiDraftReply, aiSummarize } from '../ai/client'
import { htmlToText } from '../util/text'
import { addressOf } from '../smtp/message'

/** embedded=true：平板双栏右栏嵌入，无 SafeArea / 返回头 */
export function ReadScreen({ embedded = false }: { embedded?: boolean }) {
  const { reading, body, bodyLoading, backToInbox, composeReply, composeNew, toggleSeen } = useMail()
  const [showImages, setShowImages] = useState(false)
  const [showAttachments, setShowAttachments] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiError, setAiError] = useState('')

  useEffect(() => {
    setShowImages(false)
    setShowAttachments(false)
  }, [reading?.uid, reading?.accountId])

  if (!reading) return null

  const plainText = body?.text ?? (body?.html ? htmlToText(body.html) : '')
  const markdown = '# ' + (reading.subject || '（无主题）') + '\n\n发件人：' + reading.from + '\n时间：' + fmtShortDate(reading.date) + '\n\n' + plainText

  const saveMenu = () => {
    Alert.alert('保存这封邮件', '暂存是普通条目；保险箱不显示正文预览。', [
      { text: '暂存正文', onPress: () => void saveTo('note') },
      { text: '存入保险箱', onPress: () => void saveTo('secret') },
      { text: '分享 Markdown', onPress: () => void Share.share({ message: markdown }).catch(() => undefined) },
      { text: '取消', style: 'cancel' }
    ])
  }

  const saveTo = async (kind: 'note' | 'secret') => {
    try {
      await addVaultItem({ kind, title: reading.subject || '邮件', body: markdown })
      Alert.alert('已保存', kind === 'secret' ? '已存入保险箱' : '已加入暂存箱')
    } catch (e) {
      Alert.alert('保存失败', e instanceof Error ? e.message : String(e))
    }
  }

  const openAI = async () => {
    setAiOpen(true)
    setAiBusy(true)
    setAiError('')
    setAiText('')
    try {
      setAiText(await aiSummarize({ subject: reading.subject, from: reading.from, text: plainText }))
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e))
    } finally {
      setAiBusy(false)
    }
  }

  const draftWithAI = async () => {
    setAiBusy(true)
    setAiError('')
    try {
      const draft = await aiDraftReply({ subject: reading.subject, from: reading.from, text: plainText })
      composeNew({
        accountId: reading.accountId,
        to: addressOf(reading.from),
        subject: /^re:/i.test(reading.subject) ? reading.subject : 'Re: ' + reading.subject,
        body: draft,
        inReplyTo: reading.messageId,
        references: reading.messageId
      })
      setAiOpen(false)
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e))
    } finally {
      setAiBusy(false)
    }
  }

  const meta = (
    <View style={s.metaCard}>
      <Text style={s.subject}>{reading.subject || '（无主题）'}</Text>
      <View style={s.metaRow}>
        <View style={[s.avatar, { backgroundColor: reading.accountColor }]}>
          <Text style={s.avatarText}>{prettyFrom(reading.from).slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.from} numberOfLines={1}>{prettyFrom(reading.from)}</Text>
          <Text style={s.metaDim} numberOfLines={1}>{reading.accountEmail}</Text>
          <Text style={s.metaDim}>{fmtShortDate(reading.date)}</Text>
        </View>
        <Pressable
          onPress={() => void toggleSeen(reading)}
          hitSlop={10}
          style={s.iconBtn}
        >
          <Text style={s.iconText}>{reading.flags.includes('\\Seen') ? '◉' : '○'}</Text>
        </Pressable>
        <Pressable onPress={() => composeReply(reading)} hitSlop={10} style={s.replyBtn}>
          <Text style={s.replyText}>回复</Text>
        </Pressable>
      </View>
    </View>
  )

  const actions = (
    <View style={s.actionRow}>
      <Pressable onPress={() => void openAI()} style={s.actBtn}><Text style={s.actText}>AI 摘要</Text></Pressable>
      <Pressable onPress={saveMenu} style={s.actBtn}><Text style={s.actText}>暂存 / 保险箱</Text></Pressable>
      <Pressable onPress={() => void Share.share({ message: markdown }).catch(() => undefined)} style={s.actBtn}><Text style={s.actText}>分享</Text></Pressable>
    </View>
  )

  const aiModal = (
    <Modal visible={aiOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAiOpen(false)}>
      <View style={s.aiRoot}>
        <View style={s.aiHead}>
          <Pressable onPress={() => setAiOpen(false)} hitSlop={10}><Text style={s.aiCancel}>关闭</Text></Pressable>
          <Text style={s.aiTitle}>AI 摘要</Text>
          <Pressable onPress={() => void openAI()} disabled={aiBusy} hitSlop={10}><Text style={[s.aiRefresh, aiBusy && { opacity: 0.4 }]}>重新生成</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={s.aiBody}>
          {aiBusy && <View style={s.aiLoading}><ActivityIndicator color={T.accent} /><Text style={s.aiLoadingText}>正在读这封邮件…</Text></View>}
          {!!aiError && <Text style={s.aiError}>{aiError}</Text>}
          {!!aiText && <Text selectable style={s.aiText}>{aiText}</Text>}
          {!aiBusy && !aiText && !aiError && <Text style={s.aiHint}>还没有摘要</Text>}
          <Pressable onPress={() => void draftWithAI()} disabled={aiBusy || !aiText} style={[s.aiDraft, (aiBusy || !aiText) && { opacity: 0.45 }]}>
            <Text style={s.aiDraftText}>用这份内容起草回复</Text>
          </Pressable>
          <Text style={s.aiNote}>AI 只看到这封邮件的正文；Key 存本机钥匙串。摘要可能有误，重要决定请核对原文。</Text>
        </ScrollView>
      </View>
    </Modal>
  )

  const loading = bodyLoading && !body
  const html = body?.html ?? null
  const text = body?.text ?? null
  const attachments = body?.attachments ?? []

  const content = (
    <View style={{ flex: 1 }}>
      {loading ? (
        <View style={s.loading}><ActivityIndicator size="large" color={T.accent} /><Text style={s.loadingText}>加载正文…</Text></View>
      ) : html ? (
        <View style={{ flex: 1 }}>
          <View style={s.toolbar}>
            <Text style={s.toolbarText}>{showImages ? '远程图片已允许' : '远程图片已拦截'}</Text>
            <Pressable onPress={() => setShowImages(v => !v)} hitSlop={8}>
              <Text style={s.toolbarAction}>{showImages ? '拦截图片' : '显示图片'}</Text>
            </Pressable>
          </View>
          <WebView
            key={showImages ? 'img-on' : 'img-off'}
            source={{ html: wrapHtml(html, { showImages }) }}
            style={s.web}
            originWhitelist={['*']}
            javaScriptEnabled={false}
            domStorageEnabled={false}
            allowFileAccess={false}
            allowsLinkPreview={false}
            setSupportMultipleWindows={false}
            mixedContentMode="never"
            onShouldStartLoadWithRequest={req => {
              if (!req.url || req.url === 'about:blank' || req.url.startsWith('data:')) return true
              if (/^https?:/i.test(req.url) || /^mailto:/i.test(req.url)) {
                void Linking.openURL(req.url).catch(() => undefined)
              }
              return false
            }}
          />
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.textPad}>
          <Text style={s.bodyText} selectable>{text ?? '（空正文）'}</Text>
          {body?.html === null && body?.text === null && !bodyLoading && (
            <Text style={s.bodyText}>（离线或正文暂不可用）</Text>
          )}
        </ScrollView>
      )}

      {attachments.length > 0 && (
        <View style={s.attachBar}>
          <Pressable onPress={() => setShowAttachments(v => !v)}>
            <Text style={s.attachTitle}>{attachments.length} 个附件 {showAttachments ? '▾' : '▸'}</Text>
          </Pressable>
          {showAttachments && (
            <ScrollView style={{ maxHeight: 140 }} contentContainerStyle={{ gap: 6, paddingTop: 6 }}>
              {attachments.map((a, i) => (
                <View key={i} style={s.attachRow}>
                  <Text style={s.attachName} numberOfLines={1}>{a.filename}</Text>
                  <Text style={s.attachSize}>{fmtBytes(a.size)}</Text>
                </View>
              ))}
              <Text style={s.attachNote}>附件下载下一轮支持</Text>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  )

  const wrapped = (
    <View style={{ flex: 1 }}>
      <SwipeReader>{content}</SwipeReader>
      <SwipeHint />
    </View>
  )

  if (embedded) {
    return (
      <View style={{ flex: 1 }}>
        {meta}
        {actions}
        {wrapped}
        {aiModal}
      </View>
    )
  }

  return (
    <SafeAreaView style={s.root} edges={['bottom', 'left', 'right']}>
      <View style={s.header}>
        <Pressable onPress={backToInbox} hitSlop={12}><Text style={s.back}>‹ 返回</Text></Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>{reading.accountEmail}</Text>
        <View style={{ width: 52 }} />
      </View>
      {meta}
      {actions}
      {wrapped}
      {aiModal}
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  back: { fontSize: 14, color: T.accent, fontWeight: '600', width: 60 },
  headerTitle: { flex: 1, fontSize: 12, color: T.faint, textAlign: 'center' },
  metaCard: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 8 },
  subject: { fontSize: 21, fontWeight: '700', color: T.ink, lineHeight: 29 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 2 },
  avatar: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  from: { fontSize: 14, color: T.ink, fontWeight: '600' },
  metaDim: { fontSize: 11, color: T.faint, marginTop: 2 },
  iconBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  iconText: { fontSize: 18, color: T.faint },
  replyBtn: { backgroundColor: T.accent, paddingHorizontal: 13, paddingVertical: 7, borderRadius: 9 },
  replyText: { color: T.accentInk, fontSize: 12, fontWeight: '600' },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 7, backgroundColor: T.surfaceAlt },
  toolbarText: { fontSize: 10, color: T.faint },
  toolbarAction: { fontSize: 11, color: T.accent, fontWeight: '600' },
  web: { flex: 1, backgroundColor: T.surface },
  textPad: { padding: 20, paddingBottom: 32 },
  bodyText: { fontSize: 15, lineHeight: 25, color: T.ink },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: T.faint },
  attachBar: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.hairline, paddingHorizontal: 18, paddingVertical: 10, backgroundColor: T.surface },
  attachTitle: { fontSize: 12, color: T.ink, fontWeight: '600' },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  attachName: { flex: 1, fontSize: 12, color: T.ink },
  attachSize: { fontSize: 10, color: T.faint },
  attachNote: { fontSize: 10, color: T.faint, marginTop: 2 },
  actionRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingBottom: 10 },
  actBtn: { backgroundColor: T.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  actText: { fontSize: 11, color: T.inkSoft, fontWeight: '500' },
  aiRoot: { flex: 1, backgroundColor: T.paper },
  aiHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  aiCancel: { fontSize: 14, color: T.accent, width: 64 },
  aiTitle: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600', color: T.ink },
  aiRefresh: { fontSize: 12, color: T.accent, width: 64, textAlign: 'right' },
  aiBody: { padding: 20, paddingBottom: 40 },
  aiLoading: { alignItems: 'center', paddingVertical: 30, gap: 8 },
  aiLoadingText: { fontSize: 11, color: T.faint },
  aiError: { fontSize: 12, color: T.danger, lineHeight: 18 },
  aiText: { fontSize: 15, lineHeight: 25, color: T.ink },
  aiHint: { fontSize: 12, color: T.faint, paddingVertical: 20 },
  aiDraft: { marginTop: 22, backgroundColor: T.accent, borderRadius: 11, paddingVertical: 13, alignItems: 'center' },
  aiDraftText: { color: T.accentInk, fontSize: 13, fontWeight: '700' },
  aiNote: { fontSize: 10, color: T.faint, lineHeight: 16, marginTop: 14 }
})
