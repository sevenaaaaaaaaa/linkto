import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { T } from '../theme'
import { useMail } from '../store/mail'
import { LIST_PANE_WIDTH, useTablet } from '../hooks/useTablet'
import { ReadScreen } from './ReadScreen'

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
  const isTablet = useTablet()
  const { active, messages, status, statusText, reading, openMessage, openInbox, go, backToInbox, closeReading } = useMail()

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

  const list = (
    <FlatList
      style={isTablet ? { flex: 1 } : undefined}
      data={messages}
      keyExtractor={m => String(m.uid)}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={status === 'syncing'} onRefresh={() => void openInbox(active)} tintColor={T.accent} />}
      ListEmptyComponent={
        status === 'ready' ? <Text style={s.empty}>收件箱是空的</Text> : undefined
      }
      renderItem={({ item }) => {
        const selected = isTablet && reading?.uid === item.uid
        return (
          <TouchableOpacity
            style={[s.row, selected && s.rowSelected]}
            onPress={() => void openMessage(item, isTablet ? { stay: true } : undefined)}
            activeOpacity={0.7}
          >
            <View style={s.dotCol}>
              {!item.flags.includes('\\Seen') && <View style={s.unreadDot} />}
            </View>
            <View style={s.mid}>
              <Text style={[s.from, !item.flags.includes('\\Seen') && s.fromUnread]} numberOfLines={1}>{item.from || '(未知发件人)'}</Text>
              <Text style={[s.subject, !item.flags.includes('\\Seen') && s.subjectUnread]} numberOfLines={2}>{item.subject || '（无主题）'}</Text>
            </View>
            <Text style={s.date}>{fmtDate(item.date)}</Text>
          </TouchableOpacity>
        )
      }}
    />
  )

  // 平板：左列表 + 右阅读双栏（iPad / Android 平板 / 鸿蒙 MatePad 同一布局）
  if (isTablet) {
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
        <View style={s.tabletRow}>
          <View style={s.listPane}>{list}</View>
          <View style={s.readPane}>
            {reading ? (
              <>
                <View style={s.readPaneHeader}>
                  <TouchableOpacity onPress={closeReading} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={s.back}>✕ 关闭</Text>
                  </TouchableOpacity>
                </View>
                <ReadScreen embedded />
              </>
            ) : (
              <View style={s.panePlaceholder}>
                <Text style={s.panePlaceholderIcon}>✉︎</Text>
                <Text style={s.panePlaceholderText}>从左侧选择一封邮件</Text>
              </View>
            )}
          </View>
        </View>
      </SafeAreaView>
    )
  }

  // 手机：单栏压栈
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
      {list}
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
  tabletRow: { flex: 1, flexDirection: 'row' },
  listPane: { width: LIST_PANE_WIDTH, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: T.hairline },
  readPane: { flex: 1 },
  readPaneHeader: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  panePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  panePlaceholderIcon: { fontSize: 40, color: T.faint },
  panePlaceholderText: { fontSize: 13, color: T.faint },
  list: { paddingHorizontal: 16, paddingBottom: 30 },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 13, paddingHorizontal: 4, borderRadius: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  rowSelected: { backgroundColor: 'rgba(0,129,126,0.08)' },
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