import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { T } from '../theme'
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

const TABS: Array<{ id: MailTab; label: string; glyph: string }> = [
  { id: 'mail', label: '邮件', glyph: '✉\uFE0E' },
  { id: 'fly', label: '加密', glyph: '◈' },
  { id: 'vault', label: '保险箱', glyph: '▣' },
  { id: 'settings', label: '设置', glyph: '⚙\uFE0E' }
]

function MailTab() {
  const { accounts, screen } = useMail()
  if (screen === 'compose') return <ComposeScreen />
  if (screen === 'read') return <ReadScreen />
  if (!accounts.length || screen === 'accounts') return <AccountsScreen />
  return <InboxScreen />
}

function Content({ tab }: { tab: MailTab }) {
  if (tab === 'fly') return <FlyScreen />
  if (tab === 'vault') return <VaultScreen />
  if (tab === 'settings') return <SettingsScreen />
  return <MailTab />
}

export function MainShell() {
  const isTablet = useTablet()
  const insets = useSafeAreaInsets()
  const { tab, screen, setTab } = useMail()
  const focusMode = tab === 'mail' && (screen === 'read' || screen === 'compose')

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
              const active = tab === t.id
              return (
                <Pressable key={t.id} onPress={() => select(t.id)} style={[s.railItem, active && s.railItemActive]}>
                  <Text style={[s.railGlyph, active && s.railGlyphActive]}>{t.glyph}</Text>
                  <Text style={[s.railLabel, active && s.railLabelActive]}>{t.label}</Text>
                </Pressable>
              )
            })}
          </View>
          <View style={s.tabletContent}><Content tab={tab} /></View>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.root} edges={['top', 'left', 'right']}>
      <View style={s.content}><Content tab={tab} /></View>
      {!focusMode && (
        <View style={[s.tabBar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
          {TABS.map(t => {
            const active = tab === t.id
            return (
              <Pressable key={t.id} onPress={() => select(t.id)} style={s.tabItem} hitSlop={6}>
                <Text style={[s.tabGlyph, active && s.tabGlyphActive]}>{t.glyph}</Text>
                <Text style={[s.tabLabel, active && s.tabLabelActive]}>{t.label}</Text>
              </Pressable>
            )
          })}
        </View>
      )}
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
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
  tabItem: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 2 },
  tabGlyph: { fontSize: 21, color: T.faint },
  tabGlyphActive: { color: T.accent },
  tabLabel: { fontSize: 10, color: T.faint },
  tabLabelActive: { color: T.accent, fontWeight: '600' }
})
