import { useEffect, useState } from 'react'
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
import { Icon, type IconName } from '../ui/Icon'
import { Brand, BrandMark } from '../ui/Brand'
import { RestoreEntry } from '../backup/RestoreEntry'
import { WorkbenchScreen } from '../workbench/WorkbenchScreen'
import { CaptureSheet } from '../workbench/CaptureSheet'
import { useWorkbench } from '../workbench/store'
import { pauseWorkSync, syncWorkbench } from '../workbench/sync'
import { SyncSettings } from '../workbench/SyncSettings'
import { AgentScreen } from '../agent/AgentScreen'
import { useAgent } from '../agent/store'

const TABS: Array<{ id: MailTab; label: string; icon: 'mail' | 'today' | 'agent' | 'more' }> = [
  { id: 'mail', label: '邮件', icon: 'mail' },
  { id: 'today', label: '今日', icon: 'today' },
  { id: 'agent', label: 'Agent', icon: 'agent' },
  { id: 'more', label: '更多', icon: 'more' }
]

function MoreScreen() {
  const [sync, setSync] = useState(false), [reminders, setReminders] = useState(false)
  const count = useMail(state => state.accounts.length)
  const rows: Array<{ id: MailTab; title: string; detail: string; icon: IconName }> = [
    { id: 'notes', title: '随手记与便签', detail: '想法、草稿与邮件里的下一步', icon: 'note' },
    { id: 'settings', title: '邮箱与设置', detail: `${count} 个邮箱 · AI 接口 · 应用锁`, icon: 'settings' },
    { id: 'fly', title: '萤火密信', detail: '为需要保密的内容留一个出口', icon: 'mail' },
    { id: 'vault', title: '保险箱', detail: '在自己的设备上加密保存', icon: 'shield' }
  ]
  return <ScrollView keyboardShouldPersistTaps="always" style={{ flex: 1, backgroundColor: T.paper }} contentContainerStyle={s.moreBody}>
    <Brand subtitle="邮件、安排与想法，在自己的设备间流动。" />
    <View style={{ marginTop: 16, gap: 6 }}><Text style={s.moreTitle}>工作与连接</Text><Text style={s.moreSubtitle}>从电脑继续，也从这里开始。</Text></View>
    <RestoreEntry />
    <Text style={s.sectionLabel}>你的工作台</Text>
    <View style={s.menuGroup}>{rows.map(item => <Pressable key={item.id} accessibilityRole="button" onPress={() => useMail.getState().setTab(item.id)} style={({ pressed }) => [s.menuRow, pressed && { backgroundColor: T.accentSoft }]}><View style={s.menuIcon}><Icon name={item.icon} size={20} /></View><View style={{ flex: 1 }}><Text style={s.moreCardTitle}>{item.title}</Text><Text style={s.moreSubtitle}>{item.detail}</Text></View><Icon name="chevron" size={15} color={T.faint} /></Pressable>)}</View>
    <Text style={s.sectionLabel}>设备与同步</Text>
    <View style={s.menuGroup}>{([{ title: '手机与电脑同步', detail: '用自己的邮箱承载加密内容', icon: 'restore', value: sync, action: () => setSync(!sync) }, { title: '提醒与收信', detail: '本机提醒与邮件接收状态', icon: 'today', value: reminders, action: () => setReminders(!reminders) }] as const).map(row => <Pressable key={row.title} accessibilityRole="button" accessibilityState={{ expanded: row.value }} onPress={row.action} style={s.menuRow}><View style={s.menuIcon}><Icon name={row.icon} size={20} /></View><View style={{ flex: 1 }}><Text style={s.moreCardTitle}>{row.title}</Text><Text style={s.moreSubtitle}>{row.detail}</Text></View><View style={{ transform: [{ rotate: row.value ? '90deg' : '0deg' }] }}><Icon name="chevron" size={15} color={T.faint} /></View></Pressable>)}</View>
    {sync && <SyncSettings />}{reminders && <ReminderSettings />}
    <Text style={s.footerBrand}>LinkTo · 留一点注意力给真正重要的事</Text>
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
  if (tab === 'agent') return <AgentScreen />
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
  const activeTab = ['fly', 'vault', 'settings'].includes(tab) ? 'more' : tab === 'notes' ? 'today' : tab
  const focusMode = tab === 'mail' && (screen === 'read' || screen === 'compose')
  useEffect(() => {
    const openReminder = async () => { const id = await linkToCore.takeReminder(); if (id && useMail.getState().guard === 'ready') { useMail.getState().setTab('today'); useWorkbench.getState().openCapture({ itemId: id }) } }
    void useWorkbench.getState().load().then(async () => { await openReminder(); await syncWorkbench() })
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') { void openReminder(); void syncWorkbench(); if (useMail.getState().accounts.length) void useMail.getState().refresh() }
    })
    const reminderTimer = setInterval(() => { if (AppState.currentState === 'active') void openReminder() }, 2000)
    const timer = setInterval(() => { if (AppState.currentState === 'active') { void syncWorkbench(); if (useMail.getState().accounts.length && useMail.getState().tab === 'mail') void useMail.getState().refresh() } }, 60_000)
    return () => { clearInterval(timer); clearInterval(reminderTimer); listener.remove(); pauseWorkSync(); useAgent.getState().clear(); useWorkbench.getState().clear() }
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
            <View style={s.railLogo}><BrandMark size={38} /></View>
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
            return <View key={t.id} style={{ flex: index === 2 ? 2 : 1, flexDirection: 'row' }}>
              {index === 2 && <View style={s.createSlot}><Pressable accessibilityRole="button" accessibilityLabel="全局新建邮件或随手记" onPress={create} style={({ pressed }) => [s.createButton, pressed && { opacity: 0.7 }]}><Icon name="plus" color={T.accentInk} size={22} /></Pressable></View>}
              <Pressable accessibilityRole="tab" accessibilityLabel={t.label} accessibilityState={{ selected: active }} onPress={() => select(t.id)} style={s.tabItem}>
                <View style={[s.tabIcon, active && s.activeTabIcon]}><Icon name={t.icon} color={active ? T.accent : T.faint} size={21} /></View>
                <Text maxFontSizeMultiplier={1.4} numberOfLines={1} style={[s.tabLabel, active && s.tabLabelActive]}>{t.label}</Text>
              </Pressable>
            </View>
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
  rail: { width: 86, backgroundColor: T.surfaceAlt, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: T.hairline, paddingTop: 14, alignItems: 'center', gap: 4 },
  railLogo: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#0E1116', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  railLogoText: { color: T.accentInk, fontSize: 16, fontWeight: '700' },
  railItem: { width: 70, paddingVertical: 9, borderRadius: 12, alignItems: 'center', gap: 3 },
  railItemActive: { backgroundColor: T.accentSoft },
  railGlyph: { fontSize: 20, color: T.faint },
  railGlyphActive: { color: T.accent },
  railLabel: { fontSize: 10, color: T.faint },
  railLabelActive: { color: T.accent, fontWeight: '600' },
  tabletContent: { flex: 1 },
  tabBar: { flexDirection: 'row', backgroundColor: T.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.hairline, paddingTop: 8 },
  tabItem: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 4 },
  createSlot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  createButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: T.accent, borderRadius: 12 },
  tabIcon: { width: 42, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8 }, activeTabIcon: { backgroundColor: T.accentSoft },
  backMore: { minHeight: 44, paddingHorizontal: 20, justifyContent: 'center' }, backMoreText: { color: T.accent, fontSize: 14 },
  moreTitle: { color: T.ink, fontSize: 28, fontWeight: '700' }, moreSubtitle: { color: T.faint, fontSize: 12, lineHeight: 20 }, moreCard: { backgroundColor: T.surface, padding: 18, borderRadius: 16, gap: 6, minHeight: 76 }, moreCardTitle: { fontSize: 15, fontWeight: '600', color: T.ink },
  moreBody: { padding: 24, gap: 14, maxWidth: 720, width: '100%', alignSelf: 'center', paddingBottom: 40 }, sectionLabel: { color: T.faint, fontSize: 11, fontWeight: '600', letterSpacing: 1, marginTop: 12 }, menuGroup: { borderRadius: 14, backgroundColor: T.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, overflow: 'hidden' }, menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 76, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline }, menuIcon: { width: 34, alignItems: 'center' }, footerBrand: { color: T.faint, fontSize: 11, textAlign: 'center', marginTop: 16 },
  tabGlyph: { fontSize: 21, color: T.faint },
  tabGlyphActive: { color: T.accent },
  tabLabel: { fontSize: 10, color: T.faint },
  tabLabelActive: { color: T.accent, fontWeight: '600' }
}))
