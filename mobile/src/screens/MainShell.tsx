import { useEffect } from 'react'
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { themedStyles, T } from '../theme'
import { useMail, type MailTab } from '../store/mail'
import { useTablet } from '../hooks/useTablet'
import { linkToCore } from '../native/LinkToCore'
import { AccountsScreen } from './AccountsScreen'
import { InboxScreen } from './InboxScreen'
import { ReadScreen } from './ReadScreen'
import { ComposeScreen } from './ComposeScreen'
import { FlyScreen } from './FlyScreen'
import { VaultScreen } from './VaultScreen'
import { SettingsScreen } from './SettingsScreen'
import { ReminderSettings } from '../ui/ReminderSettings'
import { Notice } from '../ui/Notice'
import { Icon } from '../ui/Icon'
import { WorkbenchScreen } from '../workbench/WorkbenchScreen'
import { CaptureSheet } from '../workbench/CaptureSheet'
import { useWorkbench } from '../workbench/store'
import { pauseWorkSync, syncWorkbench } from '../workbench/sync'
import { SyncSettings } from '../workbench/SyncSettings'

const TABS: Array<{ id: MailTab; label: string; icon: 'mail' | 'today' | 'note' | 'more' }> = [
  { id: 'mail', label: '邮件', icon: 'mail' },
  { id: 'today', label: '今日', icon: 'today' },
  { id: 'notes', label: '随手记', icon: 'note' },
  { id: 'more', label: '更多', icon: 'more' }
]

function MoreScreen() {
  return <ScrollView style={{ flex: 1, backgroundColor: T.paper }} contentContainerStyle={{ padding: 22, gap: 14, maxWidth: 760, width: '100%', alignSelf: 'center', paddingBottom: 40 }}>
    <Text style={s.moreTitle}>更多</Text><Text style={s.moreSubtitle}>让邮件、安排与想法，在自己的设备间流动。</Text>
    <SyncSettings />
    <ReminderSettings />
    {([{ id: 'settings', title: '邮箱与设置', text: '账户、AI、应用锁与本机数据' }, { id: 'fly', title: '萤火密信', text: '发送一封阅后即焚的消息' }, { id: 'vault', title: '保险箱', text: '加密暂存内容与密码' }] as const).map(item => <Pressable key={item.id} accessibilityRole="button" onPress={() => useMail.getState().setTab(item.id)} style={({ pressed }) => [s.moreCard, pressed && { opacity: 0.7 }]}><Text style={s.moreCardTitle}>{item.title}</Text><Text style={s.moreSubtitle}>{item.text}</Text></Pressable>)}
  </ScrollView>
}

function MailTab() {
  const { accounts, screen } = useMail()
  if (screen === 'compose') return <ComposeScreen />
  if (screen === 'read') return <ReadScreen />
  if (!accounts.length || screen === 'accounts') return <AccountsScreen />
  return <InboxScreen />
}

function Content({ tab }: { tab: MailTab }) {
  if (tab === 'today' || tab === 'notes') return <WorkbenchScreen mode={tab} />
  if (tab === 'more') return <MoreScreen />
  if (tab === 'fly') return <FlyScreen />
  if (tab === 'vault') return <VaultScreen />
  if (tab === 'settings') return <SettingsScreen />
  return <MailTab />
}

export function MainShell() {
  const isTablet = useTablet()
  const insets = useSafeAreaInsets()
  const { tab, screen, setTab } = useMail()
  const activeTab = ['fly', 'vault', 'settings'].includes(tab) ? 'more' : tab
  const focusMode = tab === 'mail' && (screen === 'read' || screen === 'compose')
  useEffect(() => {
    const openReminder = async () => { const id = await linkToCore.takeReminder(); if (id && useMail.getState().guard === 'ready') { useMail.getState().setTab('today'); useWorkbench.getState().openCapture({ itemId: id }) } }
    void useWorkbench.getState().load().then(async () => { await openReminder(); await syncWorkbench() })
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') { void openReminder(); void syncWorkbench(); if (useMail.getState().accounts.length) void useMail.getState().refresh() }
    })
    const reminderTimer = setInterval(() => { if (AppState.currentState === 'active') void openReminder() }, 2000)
    const timer = setInterval(() => { if (AppState.currentState === 'active') { void syncWorkbench(); if (useMail.getState().accounts.length && useMail.getState().tab === 'mail') void useMail.getState().refresh() } }, 60_000)
    return () => { clearInterval(timer); clearInterval(reminderTimer); listener.remove(); pauseWorkSync(); useWorkbench.getState().clear() }
  }, [])
  const create = () => Alert.alert('新建', '从一封邮件，或一段想法开始。', [
    { text: '写邮件', onPress: () => { if (!useMail.getState().accounts.length) { setTab('mail'); useMail.getState().go('accounts') } else useMail.getState().composeNew() } },
    { text: '随手记 / 待办', onPress: () => useWorkbench.getState().openCapture() },
    { text: '取消', style: 'cancel' }
  ])
  const content = <><View style={{ flex: 1 }}>{activeTab === 'more' && tab !== 'more' && <Pressable accessibilityRole="button" onPress={() => setTab('more')} style={s.backMore}><Text style={s.backMoreText}>‹ 更多</Text></Pressable>}<Content tab={tab} /><Notice /></View><CaptureSheet /></>

  const select = (next: MailTab) => {
    if (next === tab) return
    void linkToCore.haptic('light')
    setTab(next)
  }

  if (isTablet) {
    return (
      <SafeAreaView style={s.root} edges={['top', 'left', 'right', 'bottom']}>
        <View style={s.tabletRow}>
          <View style={s.rail}>
            <View style={s.railLogo}><Text style={s.railLogoText}>林</Text></View>
            {TABS.map(t => {
              const active = activeTab === t.id
              return (
                <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={t.label} key={t.id} onPress={() => select(t.id)} style={[s.railItem, active && s.railItemActive]}>
                  <Icon name={t.icon} color={active ? T.accent : T.faint} />
                  <Text style={[s.railLabel, active && s.railLabelActive]}>{t.label}</Text>
                </Pressable>
              )
            })}
            <Pressable accessibilityRole="button" accessibilityLabel="全局新建" onPress={create} style={s.railItem}><Icon name="plus" color={T.accent} /><Text style={s.railLabel}>新建</Text></Pressable>
          </View>
          <View style={s.tabletContent}>{content}</View>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.root} edges={['top', 'left', 'right']}>
      <View style={s.content}>{content}</View>
      {!focusMode && (
        <View style={[s.tabBar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
          {TABS.map((t, index) => {
            const active = activeTab === t.id
            return (
              <View key={t.id} style={{ flex: index === 2 ? 2 : 1, flexDirection: 'row' }}>
              {index === 2 && <Pressable accessibilityRole="button" accessibilityLabel="全局新建邮件或随手记" onPress={create} style={s.createButton}><Icon name="plus" color={T.accentInk} size={25} /></Pressable>}
              <Pressable accessibilityRole="tab" accessibilityLabel={t.label} accessibilityState={{ selected: active }} onPress={() => select(t.id)} style={s.tabItem} hitSlop={2}>
                <Icon name={t.icon} color={active ? T.accent : T.faint} />
                <Text style={[s.tabLabel, active && s.tabLabelActive]}>{t.label}</Text>
              </Pressable>
              </View>
            )
          })}
        </View>
      )}
    </SafeAreaView>
  )
}

const s = themedStyles(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  content: { flex: 1 },
  tabletRow: { flex: 1, flexDirection: 'row' },
  rail: { width: 86, backgroundColor: T.surface, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: T.hairline, paddingTop: 14, alignItems: 'center', gap: 4 },
  railLogo: { width: 34, height: 34, borderRadius: 11, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  railLogoText: { color: T.accentInk, fontSize: 16, fontWeight: '700' },
  railItem: { width: 70, paddingVertical: 9, borderRadius: 12, alignItems: 'center', gap: 3 },
  railItemActive: { backgroundColor: T.accentSoft },
  railGlyph: { fontSize: 20, color: T.faint },
  railGlyphActive: { color: T.accent },
  railLabel: { fontSize: 10, color: T.faint },
  railLabelActive: { color: T.accent, fontWeight: '600' },
  tabletContent: { flex: 1 },
  tabBar: { flexDirection: 'row', backgroundColor: T.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.hairline, paddingTop: 6 },
  tabItem: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 4 },
  createButton: { flex: 1, maxWidth: 52, height: 48, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', backgroundColor: T.accent, borderRadius: 16, marginHorizontal: 8 },
  backMore: { minHeight: 44, paddingHorizontal: 20, justifyContent: 'center' }, backMoreText: { color: T.accent, fontSize: 14 },
  moreTitle: { color: T.ink, fontSize: 30, fontWeight: '700' }, moreSubtitle: { color: T.faint, fontSize: 12, lineHeight: 20 }, moreCard: { backgroundColor: T.surface, padding: 18, borderRadius: 16, gap: 6, minHeight: 76 }, moreCardTitle: { fontSize: 15, fontWeight: '600', color: T.ink },
  tabGlyph: { fontSize: 21, color: T.faint },
  tabGlyphActive: { color: T.accent },
  tabLabel: { fontSize: 10, color: T.faint },
  tabLabelActive: { color: T.accent, fontWeight: '600' }
}))
