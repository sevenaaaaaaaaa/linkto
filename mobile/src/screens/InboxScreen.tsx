import { useMemo, useState } from 'react'
import {
  ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { T, accountInitial, fmtListDate, prettyFrom } from '../theme'
import { useMail, type MobileMessage } from '../store/mail'
import { LIST_PANE_WIDTH, useTablet } from '../hooks/useTablet'
import { SwipeRow } from '../ui/SwipeRow'
import { LensPeek } from '../ui/LensPeek'
import { ReadScreen } from './ReadScreen'
import { linkToCore } from '../native/LinkToCore'

function MessageRow({ m, unified, selected }: { m: MobileMessage; unified: boolean; selected: boolean }) {
  const unread = !m.flags.includes('\\Seen')
  return (
    <View style={[s.row, selected && s.rowSelected]}>
      <View style={[s.avatar, { backgroundColor: m.accountColor }]}>
        <Text style={s.avatarText}>{accountInitial(m.accountEmail)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.rowTop}>
          <Text style={[s.from, unread && s.fromUnread]} numberOfLines={1}>{prettyFrom(m.from)}</Text>
          <Text style={s.date}>{fmtListDate(m.date)}</Text>
        </View>
        <View style={s.rowBottom}>
          <Text style={[s.subject, unread && s.subjectUnread]} numberOfLines={1}>{m.subject || '（无主题）'}</Text>
          {unread && <View style={s.unreadDot} />}
        </View>
        {unified && <Text style={s.accountTag} numberOfLines={1}>{m.accountEmail}</Text>}
      </View>
    </View>
  )
}

function Skeleton() {
  return (
    <View style={{ opacity: 0.5 }}>
      {[0, 1, 2, 3, 4, 5].map(i => (
        <View key={i} style={s.skRow}>
          <View style={s.skAvatar} />
          <View style={{ flex: 1, gap: 7 }}>
            <View style={[s.skBar, { width: '42%' }]} />
            <View style={[s.skBar, { width: '76%' }]} />
          </View>
        </View>
      ))}
    </View>
  )
}

export function InboxScreen() {
  const isTablet = useTablet()
  const {
    accounts, messages, scope, status, statusText, reading, folders,
    openUnified, openAccount, openFolder, openMessage, toggleSeen, refresh, search,
    searchQuery, composeNew, setTab
  } = useMail()
  const [drawer, setDrawer] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState(searchQuery)
  const [peek, setPeek] = useState<MobileMessage | null>(null)

  const unread = useMemo(() => messages.filter(m => !m.flags.includes('\\Seen')).length, [messages])
  const unified = scope.kind === 'unified'
  const subtitle = unified ? accounts.length + ' 个账户' : scope.title

  const open = (m: MobileMessage) => {
    void linkToCore.haptic('light')
    void openMessage(m, isTablet ? { stay: true } : undefined)
  }

  const submitSearch = () => {
    void search(query.trim())
    setSearchOpen(true)
  }

  const cancelSearch = () => {
    setQuery('')
    setSearchOpen(false)
    void search('')
  }

  const list = (
    <FlatList
      data={messages}
      keyExtractor={m => m.accountId + ':' + m.uid}
      contentContainerStyle={messages.length ? { paddingBottom: 24 } : { flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={status === 'syncing'} onRefresh={() => void refresh()} tintColor={T.accent} />}
      ListEmptyComponent={
        status === 'syncing' ? (
          <Skeleton />
        ) : (
          <View style={s.empty}>
            <Text style={s.emptyGlyph}>{searchQuery ? '⌕' : '✉'}</Text>
            <Text style={s.emptyTitle}>{searchQuery ? '没有匹配的邮件' : '收件箱是空的'}</Text>
            <Text style={s.emptyText}>{searchQuery ? '换个关键词，或清空搜索' : '下拉刷新，或去设置里添加另一个账户'}</Text>
          </View>
        )
      }
      renderItem={({ item }) => (
        <SwipeRow
          seen={item.flags.includes('\\Seen')}
          onPress={() => open(item)}
          onLongPress={() => setPeek(item)}
          onToggle={() => void toggleSeen(item)}
        >
          <MessageRow m={item} unified={unified} selected={isTablet && reading?.uid === item.uid && reading?.accountId === item.accountId} />
        </SwipeRow>
      )}
    />
  )

  const header = (
    <View style={s.header}>
      <Pressable onPress={() => setDrawer(true)} hitSlop={10} style={s.headerIcon}><Text style={s.headerGlyph}>☰</Text></Pressable>
      <View style={{ flex: 1 }}>
        <Text style={s.title} numberOfLines={1}>{unified ? '收件箱' : scope.title === 'INBOX' ? '收件箱' : scope.title}</Text>
        <Text style={s.sub} numberOfLines={1}>{subtitle}{unread ? ' · ' + unread + ' 封未读' : ''}</Text>
      </View>
      <Pressable onPress={() => { setSearchOpen(v => !v); if (searchOpen) cancelSearch() }} hitSlop={10} style={s.headerIcon}>
        <Text style={s.headerGlyph}>⌕</Text>
      </Pressable>
      {isTablet && (
        <Pressable onPress={() => composeNew()} hitSlop={10} style={[s.headerIcon, s.composeIcon]}>
          <Text style={s.composeGlyph}>✎</Text>
        </Pressable>
      )}
    </View>
  )

  const searchBar = searchOpen ? (
    <View style={s.searchWrap}>
      <TextInput
        style={s.searchInput}
        value={query}
        onChangeText={setQuery}
        placeholder="搜索发件人 / 主题 / 正文"
        placeholderTextColor={T.faint}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={submitSearch}
      />
      <Pressable onPress={cancelSearch} hitSlop={8}><Text style={s.searchCancel}>取消</Text></Pressable>
    </View>
  ) : null

  const statusBar = status === 'syncing' ? (
    <View style={s.statusBar}><ActivityIndicator size="small" color={T.accent} /><Text style={s.statusText}>{statusText || '同步中…'}</Text></View>
  ) : status === 'error' ? (
    <View style={[s.statusBar, { backgroundColor: T.dangerSoft }]}><Text style={[s.statusText, { color: T.danger }]}>{statusText || '同步失败，下拉重试'}</Text></View>
  ) : null

  const drawerView = (
    <Modal visible={drawer} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setDrawer(false)}>
      <SafeAreaView style={s.drawerRoot}>
        <View style={s.drawerHeader}>
          <Text style={s.drawerTitle}>账户与文件夹</Text>
          <Pressable onPress={() => setDrawer(false)} hitSlop={12}><Text style={s.drawerClose}>完成</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
          <Pressable
            onPress={() => { setDrawer(false); void openUnified() }}
            style={[s.folderRow, unified && s.folderOn]}
          >
            <Text style={s.folderGlyph}>▤</Text>
            <Text style={[s.folderText, unified && s.folderTextOn]}>统一收件箱</Text>
            <Text style={s.folderCount}>{messages.length}</Text>
          </Pressable>
          {accounts.map(a => (
            <View key={a.id} style={{ marginTop: 10 }}>
              <Pressable
                onPress={() => { setDrawer(false); void openAccount(a) }}
                style={s.accountHead}
              >
                <View style={[s.drawerAvatar, { backgroundColor: a.color }]}><Text style={s.drawerAvatarText}>{accountInitial(a.email)}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.drawerEmail} numberOfLines={1}>{a.email}</Text>
                  <Text style={s.drawerServer} numberOfLines={1}>{a.host}</Text>
                </View>
              </Pressable>
              <Pressable
                onPress={() => { setDrawer(false); void openFolder(a, 'INBOX') }}
                style={[s.folderRow, s.folderIndent, scope.accountId === a.id && scope.folder === 'INBOX' && s.folderOn]}
              >
                <Text style={s.folderText}>收件箱</Text>
              </Pressable>
              {(folders[a.id] ?? []).filter(f => f.name.toUpperCase() !== 'INBOX').map(f => (
                <Pressable
                  key={f.name}
                  onPress={() => { setDrawer(false); void openFolder(a, f.name) }}
                  style={[s.folderRow, s.folderIndent, scope.accountId === a.id && scope.folder === f.name && s.folderOn]}
                >
                  <Text style={s.folderText} numberOfLines={1}>{f.name}</Text>
                </Pressable>
              ))}
            </View>
          ))}
          {!accounts.length && <Text style={s.drawerEmpty}>还没有账户</Text>}
          <Pressable onPress={() => { setDrawer(false); setTab('settings') }} style={s.manageBtn}>
            <Text style={s.manageText}>管理 / 添加账户</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )

  if (isTablet) {
    return (
      <View style={s.tabletRoot}>
        <View style={s.tabletList}>
          {header}
          {searchBar}
          {statusBar}
          {list}
        </View>
        <View style={s.tabletRead}>
          {reading ? (
            <View style={{ flex: 1 }}>
              <View style={s.readTop}>
                <Text style={s.readTopText} numberOfLines={1}>阅读</Text>
                <Pressable onPress={() => useMail.getState().closeReading()} hitSlop={12}><Text style={s.readClose}>✕</Text></Pressable>
              </View>
              <ReadScreen embedded />
            </View>
          ) : (
            <View style={s.readPlaceholder}>
              <Text style={s.readGlyph}>▤</Text>
              <Text style={s.readEmptyTitle}>选择一封邮件</Text>
              <Text style={s.readEmptyText}>左侧列表保持滚动位置；阅读后可以在这里直接回复。</Text>
            </View>
          )}
        </View>
        {drawerView}
        {peek && <LensPeek msg={peek} onClose={() => setPeek(null)} />}
      </View>
    )
  }

  return (
    <View style={s.root}>
      {header}
      {searchBar}
      {statusBar}
      {list}
      <Pressable onPress={() => composeNew()} style={s.fab} onPressIn={() => void linkToCore.haptic('light')}>
        <Text style={s.fabGlyph}>✎</Text>
      </Pressable>
      {drawerView}
      {peek && <LensPeek msg={peek} onClose={() => setPeek(null)} />}
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  tabletRoot: { flex: 1, flexDirection: 'row', backgroundColor: T.paper },
  tabletList: { width: LIST_PANE_WIDTH, backgroundColor: T.paper, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: T.hairline },
  tabletRead: { flex: 1, backgroundColor: T.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  headerIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  headerGlyph: { fontSize: 20, color: T.inkSoft },
  composeIcon: { backgroundColor: T.accent },
  composeGlyph: { fontSize: 18, color: T.accentInk },
  title: { fontSize: 21, fontWeight: '700', color: T.ink, letterSpacing: 0.1 },
  sub: { fontSize: 11, color: T.faint, marginTop: 2 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: T.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  searchInput: { flex: 1, backgroundColor: T.surfaceAlt, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 8, fontSize: 13, color: T.ink },
  searchCancel: { fontSize: 13, color: T.accent },
  statusBar: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 16, paddingVertical: 6 },
  statusText: { fontSize: 10, color: T.faint },
  row: { flexDirection: 'row', gap: 11, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: T.paper, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  rowSelected: { backgroundColor: T.accentSoft },
  avatar: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  from: { flex: 1, fontSize: 14, color: T.inkSoft },
  fromUnread: { color: T.ink, fontWeight: '700' },
  date: { fontSize: 10, color: T.faint },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 3 },
  subject: { flex: 1, fontSize: 13, color: T.faint },
  subjectUnread: { color: T.ink, fontWeight: '600' },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.accent },
  accountTag: { fontSize: 9, color: T.faint, marginTop: 3 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, paddingTop: 80 },
  emptyGlyph: { fontSize: 34, color: T.hairline },
  emptyTitle: { fontSize: 15, color: T.ink, fontWeight: '600', marginTop: 12 },
  emptyText: { fontSize: 12, color: T.faint, marginTop: 5, textAlign: 'center', lineHeight: 18 },
  skRow: { flexDirection: 'row', gap: 11, paddingHorizontal: 14, paddingVertical: 14, alignItems: 'center' },
  skAvatar: { width: 34, height: 34, borderRadius: 11, backgroundColor: T.surfaceAlt },
  skBar: { height: 10, borderRadius: 5, backgroundColor: T.surfaceAlt },
  fab: { position: 'absolute', right: 18, bottom: 18, width: 54, height: 54, borderRadius: 27, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', shadowColor: T.shadow, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 5 },
  fabGlyph: { color: T.accentInk, fontSize: 23, marginTop: -1 },
  readTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline, backgroundColor: T.surface },
  readTopText: { flex: 1, fontSize: 11, color: T.faint },
  readClose: { fontSize: 16, color: T.faint, paddingHorizontal: 6 },
  readPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 36 },
  readGlyph: { fontSize: 38, color: T.hairline },
  readEmptyTitle: { fontSize: 16, color: T.ink, fontWeight: '600', marginTop: 14 },
  readEmptyText: { fontSize: 12, color: T.faint, marginTop: 6, textAlign: 'center', lineHeight: 19, maxWidth: 260 },
  drawerRoot: { flex: 1, backgroundColor: T.paper },
  drawerHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  drawerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: T.ink },
  drawerClose: { fontSize: 14, color: T.accent, fontWeight: '600' },
  folderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 12, marginHorizontal: 10, borderRadius: 10 },
  folderIndent: { paddingLeft: 30, paddingVertical: 9 },
  folderOn: { backgroundColor: T.accentSoft },
  folderGlyph: { fontSize: 16, color: T.accent },
  folderText: { flex: 1, fontSize: 14, color: T.inkSoft },
  folderTextOn: { color: T.accent, fontWeight: '600' },
  folderCount: { fontSize: 11, color: T.faint },
  accountHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 8 },
  drawerAvatar: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  drawerAvatarText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  drawerEmail: { fontSize: 13, color: T.ink, fontWeight: '600' },
  drawerServer: { fontSize: 10, color: T.faint, marginTop: 1 },
  drawerEmpty: { padding: 20, fontSize: 13, color: T.faint },
  manageBtn: { marginTop: 20, marginHorizontal: 20, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, paddingVertical: 12, alignItems: 'center' },
  manageText: { fontSize: 13, color: T.accent, fontWeight: '600' }
})
