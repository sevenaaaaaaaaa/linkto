import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { T } from '../theme'
import { useMail } from '../store/mail'

/** embedded=true：供平板双栏右栏嵌入，无 SafeArea/返回头 */
export function ReadScreen({ embedded = false }: { embedded?: boolean }) {
  const { reading, body, backToInbox } = useMail()
  if (!reading) return null

  const content = (
    <ScrollView style={s.body} contentContainerStyle={s.bodyPad}>
      <Text style={s.subject}>{reading.subject || '（无主题）'}</Text>
      <View style={s.metaRow}>
        <Text style={s.meta}>{reading.from}</Text>
      </View>
      <View style={s.metaRow}>
        <Text style={s.metaDim}>{reading.date ? new Date(reading.date).toLocaleString('zh-CN', { hour12: false }) : ''}</Text>
      </View>
      <View style={s.divider} />
      <Text style={s.text}>{body ?? '加载中…'}</Text>
    </ScrollView>
  )

  if (embedded) return content

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text onPress={backToInbox} style={s.back}>‹ 返回</Text>
        <Text style={s.headerTitle}>邮件</Text>
        <View style={{ width: 44 }} />
      </View>
      {content}
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  back: { fontSize: 14, color: T.accent, fontWeight: '600', width: 44 },
  headerTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: T.ink, textAlign: 'center' },
  body: { flex: 1 },
  bodyPad: { paddingHorizontal: 20, paddingVertical: 20, paddingBottom: 60 },
  subject: { fontSize: 20, fontWeight: '700', color: T.ink, lineHeight: 28 },
  metaRow: { marginTop: 6 },
  meta: { fontSize: 12, color: T.accent, fontWeight: '500' },
  metaDim: { fontSize: 11, color: T.faint },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: T.hairline, marginVertical: 16 },
  text: { fontSize: 14, lineHeight: 24, color: T.ink }
})