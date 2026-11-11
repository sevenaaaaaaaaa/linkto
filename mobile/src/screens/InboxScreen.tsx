import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { themedStyles, T, accountInitial, fmtListDate, prettyFrom } from '../theme'
import { useMail, type MobileMessage } from '../store/mail'
import { LIST_PANE_WIDTH, useTablet } from '../hooks/useTablet'
import { SwipeRow } from '../ui/SwipeRow'
import { LensPeek } from '../ui/LensPeek'
import { ReadScreen } from './ReadScreen'
import { MailActions, sourceOf } from '../mail/MailActions'
import { useWorkbench } from '../workbench/store'
import { messageKey } from '../mail-cache'
import { notice } from '../ui/Notice'
import { useAppearance } from '../ui/preferences'
import { SearchText } from '../ui/SearchText'
import { linkToCore } from '../native/LinkToCore'
import { FolderSheet } from '../mail/FolderSheet'
import { Icon } from '../ui/Icon'
import { useAgent } from '../agent/store'

function MessageRow({ m, unified, selected, compact, query, snoozeUntil, onOpen }: { m: MobileMessage; unified: boolean; selected: boolean; compact: boolean; query: string; snoozeUntil?: number; onOpen(): void }) {
  const unread = !m.flags.includes('\\Seen')
  return (
    <View accessible accessibilityRole="button" accessibilityLabel={`${prettyFrom(m.from)}，${m.subject || '无主题'}${unified ? '，' + m.accountEmail : ''}`} accessibilityActions={[{ name: 'activate', label: '打开邮件' }]} onAccessibilityTap={onOpen} onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate') onOpen() }} style={[s.row, compact && { paddingVertical: 8 }, selected && s.rowSelected]}>
      <View style={[s.avatar, { backgroundColor: m.accountColor }]}>
        <Text style={s.avatarText}>{accountInitial(m.accountEmail)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.rowTop}>
          <SearchText query={query} style={[s.from, unread && s.fromUnread]} numberOfLines={1}>{prettyFrom(m.from)}</SearchText>
          <Text style={s.date}>{fmtListDate(m.date)}</Text>
        </View>
        <View style={s.rowBottom}>
          <SearchText query={query} style={[s.subject, unread && s.subjectUnread]} numberOfLines={1}>{m.subject || '（无主题）'}</SearchText>
          {unread && <View style={s.unreadDot} />}
        </View>
        {unified && <Text style={s.accountTag} numberOfLines={1}>{m.accountEmail}</Text>}
        {!!snoozeUntil && <Text style={{ color: T.accent, fontSize: 11, marginTop: 4 }}>稍后至 {new Date(snoozeUntil).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</Text>}
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
  const appearance = useAppearance()
  const [folderAccount, setFolderAccount] = useState<string | null>(null), [moving, setMoving] = useState<MobileMessage[] | null>(null)
  const actionKeys = useRef(new Set<string>())
  const quickMove = async (message: MobileMessage, kind: 'archive' | 'trash') => {
    const key = messageKey(message); if (actionKeys.current.has(key)) return; actionKeys.current.add(key)
    try { const result = await useMail.getState().moveMessage(message, kind); notice(kind === 'trash' ? '已移至垃圾箱' : '已归档', result.undo) } catch (e) { notice(String(e)) } finally { actionKeys.current.delete(key) }
  }
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  useEffect(() => { void appearance.load() }, [])
  const toggleSelection = (message: MobileMessage) => setSelected(current => {
    const next = new Set(current), key = messageKey(message)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const batch = async (kind: 'archive' | 'trash' | 'seen') => {
    setBatchBusy(true)
    const undos: Array<() => Promise<void>> = []
    let count = 0
    try {
      for (const message of messages.filter(m => selected.has(messageKey(m)))) {
        if (kind === 'seen') { if (!message.flags.includes('\\Seen')) await toggleSeen(message) }
        else { const moved = await useMail.getState().moveMessage(message, kind); if (moved.undo) undos.push(moved.undo) }
        count++
      }
      notice(`已处理 ${count} 封邮件`, undos.length ? async () => { for (const undo of [...undos].reverse()) await undo() } : undefined)
      setSelected(new Set()); setSelecting(false)
    } catch (e) {
      notice(`已处理 ${count} 封，其余未完成：${String(e)}`, undos.length ? async () => { for (const undo of [...undos].reverse()) await undo() } : undefined)
    } finally { setBatchBusy(false) }
  }
  const workItems = useWorkbench(state => state.items)
  const [showSnoozed, setShowSnoozed] = useState(false), [now, setNow] = useState(Date.now())
  useEffect(() => { setSelected(new Set()); setSelecting(false) }, [scope.kind, scope.accountId, scope.folder, showSnoozed])
  const [actions, setActions] = useState<MobileMessage | null>(null)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer) }, [])
  const held = workItems.filter(i => i.status === 'open' && Number(i.data.mailSnoozeUntil) > now && i.data.source)
  const sameSource = (m: MobileMessage, source: NonNullable<typeof held[number]['data']['source']>) => m.accountEmail.toLowerCase() === source.accountEmail.toLowerCase() && (source.messageId ? m.messageId === source.messageId : m.mailbox === source.mailbox && m.uid === source.uid)
  const visibleMessages: MobileMessage[] = showSnoozed ? held.flatMap(i => { const source = i.data.source!; const account = accounts.find(a => a.email.toLowerCase() === source.accountEmail.toLowerCase()); return account ? [{ ...source, accountId: account.id, accountColor: account.color, accountEmail: account.email, to: '', flags: [] }] : [] }) : messages.filter(m => !held.some(i => sameSource(m, i.data.source!)))
  const [drawer, setDrawer] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState(searchQuery)
  const [peek, setPeek] = useState<MobileMessage | null>(null)

  const unread = visibleMessages.filter(m => !m.flags.includes('\\Seen')).length
  const unified = scope.kind === 'unified'
  const subtitle = unified ? accounts.length + ' 个账户' : scope.title

  const open = (m: MobileMessage) => {
    if (selecting) { toggleSelection(m); return }
    void linkToCore.haptic('light')
    if (showSnoozed) { void useMail.getState().openSource(sourceOf(m)).catch(e => Alert.alert('原邮件暂不可用', String(e))); return }
    void openMessage(m, isTablet ? { stay: true } : undefined)
  }

  const submitSearch = () => {
    if (showSnoozed) useMail.setState({ searchQuery: query.trim() }); else void search(query.trim())
    setSearchOpen(true)
  }

  const cancelSearch = () => {
    setQuery('')
    setSearchOpen(false)
    if (showSnoozed) useMail.setState({ searchQuery: '' }); else void search('')
  }

  const list = (
    <FlatList
      data={showSnoozed && searchQuery ? visibleMessages.filter(m => (m.subject + ' ' + m.from).toLowerCase().includes(searchQuery.toLowerCase())) : visibleMessages}
      keyExtractor={messageKey}
      contentContainerStyle={messages.length ? { paddingBottom: 24 } : { flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={status === 'syncing'} onRefresh={() => void refresh()} tintColor={T.accent} />}
      ListEmptyComponent={
        status === 'syncing' ? (
          <Skeleton />
        ) : (
          <View style={s.empty}>
            <Icon name={searchQuery ? 'search' : 'mail'} size={40} color={T.faint} />
            <Text style={s.emptyTitle}>{searchQuery ? '没有匹配的邮件' : '收件箱是空的'}</Text>
            <Text style={s.emptyText}>{searchQuery ? '换个关键词，或清空搜索' : '下拉刷新，或去设置里添加另一个账户'}</Text>
          </View>
        )
      }
      renderItem={({ item }) => (
        <SwipeRow
          disabled={showSnoozed || selecting}
          seen={item.flags.includes('\\Seen')}
          onPress={() => open(item)}
          onLongPress={() => { if (showSnoozed) { const task = held.find(i => sameSource(item, i.data.source!)); if (task) Alert.alert('稍后处理', '可立即恢复到本应用收件箱。', [{ text: '取消' }, { text: '现在处理', onPress: () => void useWorkbench.getState().remove(task.id) }]); } else { setSelecting(true); toggleSelection(item); void linkToCore.haptic('light') } }}
          onArchive={() => void quickMove(item, 'archive')}
          onTrash={() => void quickMove(item, 'trash')}
          onToggle={() => { if (!showSnoozed && !selecting) void toggleSeen(item).catch(e => notice(String(e))) }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected.has(messageKey(item)) }} accessibilityLabel={item.subject} onPress={() => toggleSelection(item)} style={{ display: selecting ? 'flex' : 'none', width: 44, minHeight: 60, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: T.accent }}>{selected.has(messageKey(item)) ? '✓' : '○'}</Text></Pressable><View style={{ flex: 1 }}><MessageRow onOpen={() => open(item)} snoozeUntil={showSnoozed ? Number(held.find(i => sameSource(item, i.data.source!))?.data.mailSnoozeUntil) : undefined} compact={appearance.compact} query={searchQuery} m={item} unified={unified} selected={selecting ? selected.has(messageKey(item)) : isTablet && reading?.uid === item.uid && reading?.accountId === item.accountId && reading?.mailbox === item.mailbox} /></View>{!showSnoozed && !selecting && <Pressable accessibilityRole="button" accessibilityLabel={`处理邮件 ${item.subject}`} onPress={() => setActions(item)} style={{ width: 44, minHeight: 60, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: T.faint, fontSize: 21 }}>···</Text></Pressable>}</View>
        </SwipeRow>
      )}
    />
  )

  const header = (
    <View style={s.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="账户与文件夹" onPress={() => setDrawer(true)} hitSlop={10} style={s.headerIcon}><Icon name="folder" size={21} /></Pressable>
      <View style={{ flex: 1 }}>
        <Text style={s.title} numberOfLines={1}>{showSnoozed ? '稍后处理' : unified ? '收件箱' : scope.title === 'INBOX' ? '收件箱' : scope.title}</Text>
        <Text style={s.sub} numberOfLines={1}>{subtitle}{unread ? ' · ' + unread + ' 封未读' : ''}</Text>
      </View>
      <Pressable onPress={() => { setSearchOpen(v => !v); if (searchOpen) cancelSearch() }} hitSlop={10} style={s.headerIcon}>
        <Icon name="search" size={21} />
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

  const listTools = <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 16, flexWrap: 'wrap' }}>
    <Pressable accessibilityRole="button" accessibilityLabel="切换收件箱列表密度" onPress={() => void appearance.toggle()} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: T.accent, fontSize: 12 }}>{appearance.compact ? '紧凑列表' : '舒适列表'}</Text></Pressable>
    {!showSnoozed && <Pressable accessibilityRole="button" disabled={batchBusy} onPress={() => { setSelecting(!selecting); setSelected(new Set()) }} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: T.accent, fontSize: 12 }}>{selecting ? '取消选择' : '选择邮件'}</Text></Pressable>}
    {selecting && <Pressable accessibilityRole="button" onPress={() => setSelected(new Set(visibleMessages.map(messageKey)))} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: T.accent, fontSize: 12 }}>全选</Text></Pressable>}
    {!selecting && (held.length > 0 || showSnoozed) && <Pressable accessibilityRole="button" onPress={() => setShowSnoozed(!showSnoozed)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: T.accent, fontSize: 12 }}>{showSnoozed ? '返回收件箱' : `稍后处理 ${held.length}`}</Text></Pressable>}
  </View>
  const batchBar = selecting ? <View style={{ flexDirection: 'row', backgroundColor: T.surfaceAlt, paddingHorizontal: 16, gap: 18, flexWrap: 'wrap', alignItems: 'center' }}><Text style={{ color: T.inkSoft, fontSize: 12 }}>已选 {selected.size}</Text>{(['archive', 'seen', 'trash'] as const).map((kind, index) => <Pressable accessibilityRole="button" key={kind} disabled={batchBusy || !selected.size} onPress={() => void batch(kind)} style={{ minHeight: 48, justifyContent: 'center' }}><Text style={{ color: kind === 'trash' ? T.danger : T.accent, opacity: batchBusy || !selected.size ? 0.4 : 1, fontSize: 13 }}>{['归档', '标已读', '移至垃圾箱'][index]}</Text></Pressable>)}</View> : null

  const selectedMessages = messages.filter(m => selected.has(messageKey(m)))
  const startMove = () => { if (new Set(selectedMessages.map(m => m.accountId)).size !== 1) { Alert.alert('请选择同一个邮箱的邮件', 'IMAP 文件夹移动在同一邮箱内完成，请按邮箱分别选择。'); return }; setMoving(selectedMessages) }
  const extraBatch = selecting ? <View style={{ flexDirection: 'row', paddingHorizontal: 16, gap: 22, backgroundColor: T.surfaceAlt }}><Pressable accessibilityRole="button" disabled={batchBusy || !selected.size} onPress={startMove} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: T.accent }}>移动到…</Text></Pressable><Pressable accessibilityRole="button" disabled={batchBusy || !selected.size} onPress={() => { if (!useAgent.getState().setInput(selectedMessages)) { notice('Agent 正在执行，请先停止或等待完成'); return }; setTab('agent') }} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: T.accent }}>交给 Agent</Text></Pressable></View> : null
  const folderSheet = folderAccount ? <FolderSheet accountId={folderAccount} onClose={() => setFolderAccount(null)} /> : moving?.length ? <FolderSheet accountId={moving[0].accountId} messages={moving} onClose={() => { setMoving(null); setSelecting(false); setSelected(new Set()) }} /> : null

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
            onPress={() => { setDrawer(false); setShowSnoozed(false); void openUnified() }}
            style={[s.folderRow, unified && s.folderOn]}
          >
            <Text style={s.folderGlyph}>▤</Text>
            <Text style={[s.folderText, unified && s.folderTextOn]}>统一收件箱</Text>
            <Text style={s.folderCount}>{messages.length}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => { setShowSnoozed(true); setDrawer(false) }} style={s.folderRow}><Text style={s.folderText}>稍后处理</Text><Text style={s.folderCount}>{held.length}</Text></Pressable>
          {accounts.map(a => (
            <View key={a.id} style={{ marginTop: 10 }}>
              <Pressable
                onPress={() => { setDrawer(false); setShowSnoozed(false); void openAccount(a) }}
                style={s.accountHead}
              >
                <View style={[s.drawerAvatar, { backgroundColor: a.color }]}><Text style={s.drawerAvatarText}>{accountInitial(a.email)}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.drawerEmail} numberOfLines={1}>{a.email}</Text>
                  <Text style={s.drawerServer} numberOfLines={1}>{a.host}</Text>
                </View>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => { setDrawer(false); setFolderAccount(a.id) }} style={s.folderRow}><Text style={{ color: T.accent, fontSize: 13 }}>新建 / 管理文件夹</Text></Pressable>
              <Pressable
                onPress={() => { setDrawer(false); void openFolder(a, 'INBOX') }}
                style={[s.folderRow, s.folderIndent, scope.accountId === a.id && scope.folder === 'INBOX' && s.folderOn]}
              >
                <Text style={s.folderText}>收件箱</Text>
              </Pressable>
              {(folders[a.id] ?? []).filter(f => f.name.toUpperCase() !== 'INBOX').map(f => (
                <Pressable
                  key={f.name}
                  onPress={() => { setDrawer(false); setShowSnoozed(false); void openFolder(a, f.name) }}
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
          {listTools}
          {batchBar}{extraBatch}
          {searchBar}
          {statusBar}
          {list}
        </View>
        <View style={s.tabletRead}>
          {reading ? (
            <View style={{ flex: 1 }}>
              <View style={s.readTop}>
                <Text style={s.readTopText} numberOfLines={1}>阅读</Text>
                <Pressable onPress={() => useMail.getState().closeReading()} hitSlop={12}><Icon name="close" size={21} /></Pressable>
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
        <MailActions message={actions} onPeek={setPeek} onClose={() => setActions(null)} />
      {drawerView}{folderSheet}
        {peek && <LensPeek msg={peek} onClose={() => setPeek(null)} />}
      </View>
    )
  }

  return (
    <View style={s.root}>
      {header}
      {listTools}
      {batchBar}{extraBatch}
      {searchBar}
      {statusBar}
      {list}
      <Pressable onPress={() => composeNew()} style={s.fab} onPressIn={() => void linkToCore.haptic('light')}>
        <Text style={s.fabGlyph}>✎</Text>
      </Pressable>
      <MailActions message={actions} onPeek={setPeek} onClose={() => setActions(null)} />
      {drawerView}{folderSheet}
      {peek && <LensPeek msg={peek} onClose={() => setPeek(null)} />}
    </View>
  )
}

const s = themedStyles(() => StyleSheet.create({
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
}))
