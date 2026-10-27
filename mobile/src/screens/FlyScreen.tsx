import { useState } from 'react'
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View
} from 'react-native'
import { T, fmtShortDate } from '../theme'
import { composeFly, openFly, type FlyComposeResult, type FlyOpenResult } from '../fly/relay'
import { addVaultItem } from '../vault/store'
import { copyWithClear } from '../ui/clipboard'
import { linkToCore } from '../native/LinkToCore'

type FlyMode = 'link' | 'link-code' | 'code'
const MODES: Array<{ id: FlyMode; label: string; hint: string }> = [
  { id: 'link', label: '链接', hint: '密钥在链接 # 后，链接即钥匙' },
  { id: 'link-code', label: '链接 + 口令', hint: '链接和 6 个词分开传，缺一不可' },
  { id: 'code', label: '纯口令', hint: '只需网址 + 6 个词，口令决定信箱' }
]
const TTLS: Array<{ v: number; label: string }> = [
  { v: 3600, label: '1 小时' },
  { v: 86400, label: '24 小时' },
  { v: 7 * 86400, label: '7 天' }
]

export function FlyScreen() {
  const [tab, setTab] = useState<'write' | 'read'>('write')
  const [text, setText] = useState('')
  const [flyMode, setFlyMode] = useState<FlyMode>('link')
  const [ttl, setTtl] = useState(86400)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FlyComposeResult | null>(null)
  const [input, setInput] = useState('')
  const [code, setCode] = useState('')
  const [needCode, setNeedCode] = useState(false)
  const [opened, setOpened] = useState<FlyOpenResult | null>(null)
  const [error, setError] = useState('')
  const [actionNote, setActionNote] = useState('')

  const write = async () => {
    if (!text.trim()) { setError('先写点内容'); return }
    setBusy(true); setError(''); setResult(null)
    try {
      const r = await composeFly({ text: text.trim(), mode: flyMode, ttlSeconds: ttl })
      if (!r.ok) setError(r.error ?? '生成失败')
      else { setResult(r); void linkToCore.haptic('medium') }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const read = async () => {
    if (!input.trim()) { setError('粘贴链接或 6 个词'); return }
    setBusy(true); setError(''); setOpened(null); setActionNote('')
    try {
      const r = await openFly(input, code)
      if (!r.ok && r.needsCode) { setNeedCode(true); setError(r.error ?? '需要口令') }
      else if (!r.ok) setError(r.error ?? '打开失败')
      else { setOpened(r); setNeedCode(false); void linkToCore.haptic('heavy') }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const shareResult = async (r: FlyComposeResult) => {
    const msg = r.mode === 'code'
      ? (r.portal ?? '') + '\n口令：' + (r.code ?? '')
      : (r.link ?? '') + (r.code ? '\n口令：' + r.code : '')
    try { await Share.share({ message: msg }) } catch { /* ignore */ }
  }

  const saveOpened = async (kind: 'note' | 'secret') => {
    if (!opened?.text) return
    try {
      await addVaultItem({ kind, title: '萤火密信 · ' + fmtShortDate(Date.now()), body: opened.text })
      setActionNote(kind === 'secret' ? '已存入保险箱' : '已暂存')
      void linkToCore.haptic('light')
    } catch (e) {
      setActionNote(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <View style={s.root}>
      <View style={s.inner}>
      <View style={s.header}>
        <Text style={s.title}>萤火密信</Text>
        <Text style={s.sub}>一次性 · 无身份 · 读后即焚</Text>
      </View>
      <View style={s.seg}>
        <Pressable onPress={() => { setTab('write'); setError('') }} style={[s.segItem, tab === 'write' && s.segOn]}>
          <Text style={[s.segText, tab === 'write' && s.segTextOn]}>写密信</Text>
        </Pressable>
        <Pressable onPress={() => { setTab('read'); setError('') }} style={[s.segItem, tab === 'read' && s.segOn]}>
          <Text style={[s.segText, tab === 'read' && s.segTextOn]}>读密信</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {tab === 'write' ? (
            <>
              <Text style={s.label}>正文</Text>
              <TextInput
                style={s.input}
                value={text}
                onChangeText={setText}
                placeholder="只在这里输入；发送后明文不落盘"
                placeholderTextColor={T.faint}
                multiline
                textAlignVertical="top"
              />
              <Text style={s.label}>打开方式</Text>
              <View style={s.chips}>
                {MODES.map(m => (
                  <Pressable key={m.id} onPress={() => setFlyMode(m.id)} style={[s.chip, flyMode === m.id && s.chipOn]}>
                    <Text style={[s.chipText, flyMode === m.id && s.chipTextOn]}>{m.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={s.hint}>{MODES.find(m => m.id === flyMode)?.hint}</Text>
              <Text style={s.label}>有效期</Text>
              <View style={s.chips}>
                {TTLS.map(t => (
                  <Pressable key={t.v} onPress={() => setTtl(t.v)} style={[s.chip, ttl === t.v && s.chipOn]}>
                    <Text style={[s.chipText, ttl === t.v && s.chipTextOn]}>{t.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable onPress={() => void write()} disabled={busy} style={[s.primary, busy && { opacity: 0.55 }]}>
                {busy ? <ActivityIndicator color={T.accentInk} /> : <Text style={s.primaryText}>生成一次性密信</Text>}
              </Pressable>
              {!!error && <Text style={s.error}>{error}</Text>}

              {result?.ok && (
                <View style={s.card}>
                  <Text style={s.cardTitle}>密信已投递</Text>
                  <Text style={s.cardMeta}>有效期至 {result.expiresAt ? fmtShortDate(result.expiresAt) : ''} · 读后即焚</Text>
                  {!!result.link && (
                    <>
                      <Text style={s.cardLabel}>链接</Text>
                      <Text selectable style={s.mono}>{result.link}</Text>
                      <View style={s.actions}>
                        <Pressable onPress={() => { copyWithClear(result.link!); setActionNote('链接已复制，45 秒后清除') }} style={s.smallBtn}><Text style={s.smallText}>复制链接</Text></Pressable>
                        <Pressable onPress={() => void shareResult(result)} style={s.smallBtn}><Text style={s.smallText}>分享</Text></Pressable>
                      </View>
                    </>
                  )}
                  {!!result.portal && (
                    <>
                      <Text style={s.cardLabel}>入口</Text>
                      <Text selectable style={s.mono}>{result.portal}</Text>
                    </>
                  )}
                  {!!result.code && (
                    <>
                      <Text style={s.cardLabel}>6 词口令（只显示一次）</Text>
                      <Text selectable style={s.code}>{result.code}</Text>
                      <View style={s.actions}>
                        <Pressable onPress={() => { copyWithClear(result.code!); setActionNote('口令已复制，45 秒后清除') }} style={s.smallBtn}><Text style={s.smallText}>复制口令</Text></Pressable>
                        <Pressable onPress={() => void shareResult(result)} style={s.smallBtn}><Text style={s.smallText}>分享</Text></Pressable>
                      </View>
                    </>
                  )}
                  <Text style={s.note}>口令不要和链接走同一条信道；对方打开成功后中继立即删除密文。</Text>
                </View>
              )}
            </>
          ) : (
            <>
              <Text style={s.label}>链接 / 6 词口令</Text>
              <TextInput
                style={[s.input, { minHeight: 100 }]}
                value={input}
                onChangeText={v => { setInput(v); setNeedCode(false) }}
                placeholder="https://…/r/… 或 pupil review miss seven police either"
                placeholderTextColor={T.faint}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
              />
              {needCode && (
                <>
                  <Text style={s.label}>这封密信还需要 6 词口令</Text>
                  <TextInput
                    style={s.input}
                    value={code}
                    onChangeText={setCode}
                    placeholder="6 个词，用空格分开"
                    placeholderTextColor={T.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </>
              )}
              <Pressable onPress={() => void read()} disabled={busy} style={[s.primary, busy && { opacity: 0.55 }]}>
                {busy ? <ActivityIndicator color={T.accentInk} /> : <Text style={s.primaryText}>打开并焚毁</Text>}
              </Pressable>
              {!!error && <Text style={s.error}>{error}</Text>}

              {opened?.ok && (
                <View style={s.card}>
                  <View style={s.rowBetween}>
                    <Text style={s.cardTitle}>已解密</Text>
                    <Text style={[s.burn, { color: opened.burned ? T.ok : T.warn }]}>{opened.burned ? '已焚毁' : '焚毁未确认'}</Text>
                  </View>
                  <Text style={s.cardMeta}>密文已从服务端删除；正文只在本机内存</Text>
                  <Text selectable style={s.opened}>{opened.text}</Text>
                  <View style={s.actions}>
                    <Pressable onPress={() => { copyWithClear(opened.text!); setActionNote('正文已复制，45 秒后清除') }} style={s.smallBtn}><Text style={s.smallText}>复制</Text></Pressable>
                    <Pressable onPress={() => void saveOpened('note')} style={s.smallBtn}><Text style={s.smallText}>暂存</Text></Pressable>
                    <Pressable onPress={() => void saveOpened('secret')} style={[s.smallBtn, s.secretBtn]}><Text style={s.secretText}>存入保险箱</Text></Pressable>
                  </View>
                  {!!actionNote && <Text style={s.note}>{actionNote}</Text>}
                  <Pressable onPress={() => { setOpened(null); setInput(''); setCode(''); setNeedCode(false) }} style={s.again}>
                    <Text style={s.againText}>再读一封</Text>
                  </Pressable>
                </View>
              )}
              <View style={s.info}>
                <Text style={s.infoText}>打开成功即请求中继焚毁；失败不会焚毁，可以检查口令后重试。纯口令模式只需网址 + 6 个词。</Text>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  inner: { flex: 1, width: '100%', maxWidth: 680, alignSelf: 'center' },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  title: { fontSize: 22, fontWeight: '700', color: T.ink },
  sub: { fontSize: 11, color: T.faint, marginTop: 3 },
  seg: { flexDirection: 'row', marginHorizontal: 20, backgroundColor: T.surfaceAlt, borderRadius: 10, padding: 3, marginBottom: 4 },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8 },
  segOn: { backgroundColor: T.surface },
  segText: { fontSize: 12, color: T.faint },
  segTextOn: { color: T.ink, fontWeight: '600' },
  body: { padding: 20, paddingBottom: 40 },
  label: { fontSize: 11, color: T.faint, marginTop: 14, marginBottom: 6 },
  input: { backgroundColor: T.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, borderRadius: 11, paddingHorizontal: 13, paddingVertical: 11, fontSize: 14, color: T.ink, minHeight: 120, lineHeight: 21 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, backgroundColor: T.surface, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 18 },
  chipOn: { backgroundColor: T.accentSoft, borderColor: T.accent },
  chipText: { fontSize: 12, color: T.faint },
  chipTextOn: { color: T.accent, fontWeight: '600' },
  hint: { fontSize: 11, color: T.faint, marginTop: 7, lineHeight: 16 },
  primary: { marginTop: 18, backgroundColor: T.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: T.accentInk, fontSize: 14, fontWeight: '700' },
  error: { marginTop: 12, fontSize: 12, color: T.danger, lineHeight: 18 },
  card: { marginTop: 18, backgroundColor: T.surface, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, padding: 16 },
  cardTitle: { fontSize: 15, color: T.ink, fontWeight: '700' },
  cardMeta: { fontSize: 10, color: T.faint, marginTop: 3, marginBottom: 8 },
  cardLabel: { fontSize: 10, color: T.faint, marginTop: 12, marginBottom: 4 },
  mono: { fontSize: 11, color: T.inkSoft, lineHeight: 17 },
  code: { fontSize: 17, color: T.ink, fontWeight: '600', lineHeight: 27, letterSpacing: 0.2 },
  opened: { fontSize: 15, lineHeight: 25, color: T.ink, marginTop: 10 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  smallBtn: { backgroundColor: T.surfaceAlt, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 7 },
  smallText: { fontSize: 11, color: T.inkSoft, fontWeight: '500' },
  secretBtn: { backgroundColor: T.accentSoft },
  secretText: { fontSize: 11, color: T.accent, fontWeight: '600' },
  note: { fontSize: 10, color: T.faint, lineHeight: 16, marginTop: 12 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  burn: { fontSize: 10, fontWeight: '600' },
  again: { marginTop: 14, alignSelf: 'flex-start' },
  againText: { fontSize: 12, color: T.accent, fontWeight: '600' },
  info: { marginTop: 18, backgroundColor: T.okSoft, borderRadius: 12, padding: 12 },
  infoText: { fontSize: 11, color: T.inkSoft, lineHeight: 17 }
})
