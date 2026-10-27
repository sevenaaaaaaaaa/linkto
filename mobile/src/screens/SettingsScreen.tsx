import { useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { T, accountInitial } from '../theme'
import { useMail } from '../store/mail'
import { linkToCore } from '../native/LinkToCore'
import { DEFAULT_RELAY, getRelayUrl, setRelayUrl } from '../fly/relay'
import { getAIConfig, saveAIConfig } from '../ai/client'

export function SettingsScreen() {
  const { accounts, deleteAccount, openAccount, lockNow, setTab, go } = useMail()
  const [relay, setRelay] = useState(DEFAULT_RELAY)
  const [relayNote, setRelayNote] = useState('')
  const [aiBase, setAiBase] = useState('https://api.openai.com/v1')
  const [aiModel, setAiModel] = useState('gpt-4o-mini')
  const [aiKey, setAiKey] = useState('')
  const [aiHasKey, setAiHasKey] = useState(false)
  const [aiNote, setAiNote] = useState('')

  useEffect(() => {
    void getRelayUrl().then(setRelay)
    void getAIConfig().then(c => { setAiBase(c.baseUrl); setAiModel(c.model); setAiHasKey(c.hasKey) })
  }, [])

  const saveAI = async (clear = false) => {
    if (!clear && !aiHasKey && !aiKey.trim()) { setAiNote('请输入 AI Key'); return }
    await saveAIConfig({ baseUrl: aiBase, model: aiModel, ...(clear ? { key: '' } : aiKey.trim() ? { key: aiKey.trim() } : {}) })
    setAiKey('')
    setAiHasKey(clear ? false : true)
    setAiNote(clear ? 'AI Key 已清除' : '已保存；Key 存系统钥匙串')
  }

  const saveRelay = async () => {
    await setRelayUrl(relay === DEFAULT_RELAY ? '' : relay)
    setRelayNote('已保存；下一封密信生效')
  }

  const manage = () => {
    setTab('mail')
    go('accounts')
  }

  const confirmDelete = (id: string, email: string) => {
    Alert.alert('删除账户', '会同时删除钥匙串里的凭据。确定删除 ' + email + '？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void deleteAccount(id) }
    ])
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>设置</Text>
        <Text style={s.sub}>账户、安全与本机数据</Text>
      </View>
      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.section}>账户</Text>
        <View style={s.cardList}>
          {accounts.map(a => (
            <Pressable
              key={a.id}
              onPress={() => { setTab('mail'); void openAccount(a) }}
              style={({ pressed }) => [s.row, pressed && { backgroundColor: T.accentSoft }]}
            >
              <View style={[s.avatar, { backgroundColor: a.color }]}><Text style={s.avatarText}>{accountInitial(a.email)}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.email} numberOfLines={1}>{a.email}</Text>
                <Text style={s.server} numberOfLines={1}>{a.host}:{a.port} · SMTP {a.smtpHost}:{a.smtpPort}</Text>
              </View>
              <Pressable hitSlop={10} onPress={() => confirmDelete(a.id, a.email)}>
                <Text style={s.delete}>删除</Text>
              </Pressable>
              <Text style={s.chevron}>›</Text>
            </Pressable>
          ))}
          {!accounts.length && <Text style={s.empty}>还没有账户</Text>}
        </View>
        <Pressable onPress={manage} style={s.primaryBtn}>
          <Text style={s.primaryText}>{accounts.length ? '管理 / 添加账户' : '添加第一个账户'}</Text>
        </Pressable>

        <Text style={s.section}>萤火密信</Text>
        <View style={s.cardList}>
          <View style={{ padding: 14, gap: 6 }}>
            <Text style={s.email}>中继地址</Text>
            <Text style={s.server}>默认使用你自己的 Cloudflare Worker；纯口令模式必须有它</Text>
            <TextInput
              style={s.input}
              value={relay}
              onChangeText={setRelay}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={DEFAULT_RELAY}
              placeholderTextColor={T.faint}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable onPress={() => void saveRelay()} style={s.smallBtn}><Text style={s.smallText}>保存</Text></Pressable>
              <Pressable onPress={() => { setRelay(DEFAULT_RELAY); void setRelayUrl(''); setRelayNote('已恢复默认') }} style={s.smallBtn}><Text style={s.smallText}>恢复默认</Text></Pressable>
            </View>
            {!!relayNote && <Text style={s.note}>{relayNote}</Text>}
          </View>
        </View>

        <Text style={s.section}>AI 助手</Text>
        <View style={s.cardList}>
          <View style={{ padding: 14, gap: 6 }}>
            <Text style={s.email}>OpenAI 兼容接口</Text>
            <Text style={s.server}>用于「AI 摘要」和「AI 起草回复」；Key 只存本机钥匙串</Text>
            <TextInput style={s.input} value={aiBase} onChangeText={setAiBase} autoCapitalize="none" autoCorrect={false} placeholder="https://api.openai.com/v1" placeholderTextColor={T.faint} />
            <TextInput style={s.input} value={aiModel} onChangeText={setAiModel} autoCapitalize="none" autoCorrect={false} placeholder="gpt-4o-mini" placeholderTextColor={T.faint} />
            <TextInput style={s.input} value={aiKey} onChangeText={setAiKey} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder={aiHasKey ? '已配置 Key（留空则不修改）' : 'sk-…'} placeholderTextColor={T.faint} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable onPress={() => void saveAI()} style={s.smallBtn}><Text style={s.smallText}>保存 AI 设置</Text></Pressable>
              {aiHasKey && <Pressable onPress={() => void saveAI(true)} style={s.smallBtn}><Text style={[s.smallText, { color: T.danger }]}>清除 Key</Text></Pressable>}
            </View>
            {!!aiNote && <Text style={s.note}>{aiNote}</Text>}
          </View>
        </View>

        <Text style={s.section}>安全</Text>
        <View style={s.cardList}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.email}>主密码守卫</Text>
              <Text style={s.server}>错误阶梯锁定；累计 15 次焚毁本地凭据</Text>
            </View>
            <View style={s.badge}><Text style={s.badgeText}>已启用</Text></View>
          </View>
          <Pressable
            onPress={() => { void linkToCore.haptic('medium'); void lockNow() }}
            style={({ pressed }) => [s.row, pressed && { backgroundColor: T.accentSoft }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.email}>立即锁定</Text>
              <Text style={s.server}>断开 IMAP/SMTP 连接，回到主密码解锁页</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </Pressable>
        </View>

        <Text style={s.section}>关于</Text>
        <View style={s.cardList}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.email}>林可兔 LinkTo · 移动版</Text>
              <Text style={s.server}>v0.4.0 · React Native 0.87 · iOS / iPadOS</Text>
            </View>
          </View>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.email}>数据只在本机</Text>
              <Text style={s.server}>邮件经 IMAP 直连；凭据在系统钥匙串；没有中转服务器</Text>
            </View>
          </View>
        </View>
        <Text style={s.footnote}>移动版与 Mac 版独立编号；当前版本把多账户、文件夹、搜索、HTML 阅读与发信补齐。</Text>
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  title: { fontSize: 22, fontWeight: '700', color: T.ink },
  sub: { fontSize: 12, color: T.faint, marginTop: 2 },
  body: { maxWidth: 720, width: '100%', alignSelf: 'center', padding: 20, paddingBottom: 40 },
  section: { fontSize: 12, fontWeight: '600', color: T.faint, letterSpacing: 0.4, marginTop: 18, marginBottom: 8 },
  cardList: { backgroundColor: T.surface, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.hairline },
  avatar: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  email: { fontSize: 14, color: T.ink, fontWeight: '500' },
  server: { fontSize: 11, color: T.faint, marginTop: 2 },
  delete: { fontSize: 12, color: T.danger },
  chevron: { fontSize: 20, color: T.faint, marginLeft: 2 },
  empty: { padding: 16, fontSize: 13, color: T.faint, textAlign: 'center' },
  primaryBtn: { marginTop: 10, backgroundColor: T.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  primaryText: { color: T.accentInk, fontSize: 14, fontWeight: '600' },
  badge: { backgroundColor: T.okSoft, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 10, color: T.ok, fontWeight: '600' },
  footnote: { fontSize: 11, color: T.faint, lineHeight: 17, marginTop: 18 },
  input: { backgroundColor: T.surfaceAlt, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, fontSize: 12, color: T.ink, marginTop: 2 },
  smallBtn: { backgroundColor: T.surfaceAlt, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 7 },
  smallText: { fontSize: 11, color: T.inkSoft, fontWeight: '500' },
  note: { fontSize: 10, color: T.ok, marginTop: 2 }
})
