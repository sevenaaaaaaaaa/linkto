import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { T } from '../theme'
import { useMail } from '../store/mail'

const fmtDate = (t: number) => {
  if (!t) return ''
  const d = new Date(t)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : `${d.getMonth() + 1}/${d.getDate()}`
}

export function InboxScreen() {
  const { active, messages, status, statusText, openMessage, openInbox, go, backToInbox } = useMail()

  if (!active) {
    return (
      <SafeAreaView style={s.root}>
        <Text style={s.empty}>未选择账户</Text>
        <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={() => go('accounts')}>
          <Text style={s.btnPrimaryText}>返回账户页</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={backToInbox} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={s.back}>‹ 账户</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{active.email}</Text>
        <TouchableOpacity onPress={() => void openInbox(active)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={s.refresh}>刷新</Text>
        </TouchableOpacity>
      </View>

      {status !== 'ready' && (
        <View style={s.statusBar}>
          <Text style={[s.statusText, status === 'error' && { color: T.danger }]}>
            {statusText || (status === 'syncing' ? '同步中…' : '')}
          </Text>
        </View>
      )}

      <FlatList
        data={messages}
        keyExtractor={m => String(m.uid)}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={status === 'syncing'} onRefresh={() => void openInbox(active)} tintColor={T.accent} />}
        ListEmptyComponent={
          status === 'ready' ? <Text style={s.empty}>收件箱是空的</Text> : undefined
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={s.row} onPress={() => void openMessage(item)} activeOpacity={0.7}>
            <View style={s.dotCol}>
              {!item.flags.includes('\\Seen') && <View style={s.unreadDot} />}
            </View>
            <View style={s.mid}>
              <Text style={[s.from, !item.flags.includes('\\Seen') && s.fromUnread]} numberOfLines={1}>{item.from || '(未知发件人)'}</Text>
              <Text style={[s.subject, !item.flags.includes('\\Seen') && s.subjectUnread]} numberOfLines={2}>{item.subject || '（无主题）'}</Text>
            </View>
            <Text style={s.date}>{fmtDate(item.date)}</Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline, gap: 10 },
  back: { fontSize: 14, color: T.accent, fontWeight: '600' },
  headerTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: T.ink, textAlign: 'center' },
  refresh: { fontSize: 14, color: T.accent, fontWeight: '600' },
  statusBar: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(0,129,126,0.08)' },
  statusText: { fontSize: 12, color: T.accent },
  list: { paddingHorizontal: 16, paddingBottom: 30 },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  dotCol: { width: 8, justifyContent: 'center' },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.accent },
  mid: { flex: 1 },
  from: { fontSize: 12, color: T.faint },
  fromUnread: { color: T.ink, fontWeight: '600' },
  subject: { fontSize: 14, color: T.faint, marginTop: 2, lineHeight: 19 },
  subjectUnread: { color: T.ink },
  date: { fontSize: 11, color: T.faint, alignSelf: 'flex-start', marginTop: 3 },
  empty: { textAlign: 'center', color: T.faint, marginTop: 80, fontSize: 13 },
  btn: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', marginHorizontal: 20 },
  btnPrimary: { backgroundColor: T.accent },
  btnPrimaryText: { color: T.accentInk, fontSize: 14, fontWeight: '600' }
})