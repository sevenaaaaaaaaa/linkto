import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useMail } from '../store/mail'
import { useAgent, type Recipe } from './store'
import { T, themedStyles } from '../theme'
import { Icon } from '../ui/Icon'
import { notice } from '../ui/Notice'
import { useReducedMotion } from '../hooks/useReducedMotion'
export function AgentScreen() {
  const undoLock = useRef(false), [undoing, setUndoing] = useState(false)
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null), reduced = useReducedMotion()
  const { input, busy, progress, receipt, setInput, run, cancel } = useAgent()
  useEffect(() => { if (receipt) scroll.current?.scrollTo({ y: 0, animated: !reduced }) }, [receipt, reduced])
  const messages = useMail(s => s.messages), scope = useMail(s => s.scope)
  const source = input ?? messages
  const read = Math.min(20, source.filter(m => m.flags.includes('\\Seen')).length)
  const start = (recipe: Recipe) => {
    scroll.current?.scrollTo({ y: 0, animated: !reduced })
    if (recipe === 'archive') Alert.alert(`归档 ${read} 封已读邮件？`, '范围为当前已加载的邮件，最多 20 封。邮件会移动到各自邮箱的归档文件夹。', [{ text: '取消', style: 'cancel' }, { text: '归档已读邮件', onPress: () => void run(recipe) }])
    else void run(recipe)
  }
  const cards: Array<{ id: Recipe; title: string; text: string; tag: string }> = [
    { id: 'plan', title: '邮件变成今日行动', text: '提取邮件待办，去重保存并排入今日。', tag: 'AI · 最多 8 封' },
    { id: 'brief', title: '快速读完重点', text: '把要点与下一步汇成一页，保留原邮件。', tag: 'AI · 最多 8 封' },
    { id: 'schedule', title: '一键整理今日', text: '绕开固定安排与休息，自动填入空档。', tag: '本机执行 · 无需 AI' },
    { id: 'archive', title: `整理 ${read} 封已读邮件`, text: '归档本次加载的已读邮件，支持撤销。', tag: '邮箱执行 · 最多 20 封' }
  ]
  return <ScrollView ref={scroll} style={s.root} contentContainerStyle={s.body}>
    <View style={s.header}><View style={{ flex: 1 }}><Text style={s.eyebrow}>让一步操作，完成一串工作</Text><Text style={s.title}>Agent</Text></View><Icon name="agent" size={32} color={T.accent} /></View>
    <View style={s.scope}><Text style={s.scopeTitle}>{input ? `已选 ${input.length} 封邮件` : `${scope.title} · 当前加载范围`}</Text><Text style={s.hint}>{input ? '使用你从邮件列表交来的内容。' : 'AI 默认处理最近未读邮件；可先在邮件列表多选再交给 Agent。'}</Text>{input && <Pressable accessibilityRole="button" disabled={busy} onPress={() => setInput(null)} style={s.hit}><Text style={s.link}>改用当前邮件列表</Text></Pressable>}</View>
    <Text style={s.hint}>AI 工作流会将这批邮件内容提交至你配置的 AI 接口。新待办默认不设提醒，内容可编辑；执行结果支持撤销。</Text>
    {busy && <View style={s.scope}><Text accessibilityLiveRegion="polite" style={s.scopeTitle}>{progress}</Text><Pressable accessibilityRole="button" onPress={cancel} style={s.hit}><Text style={s.link}>停止后续步骤</Text></Pressable></View>}
    {receipt && <View style={s.receipt}><Text style={s.cardTitle}>{receipt.title}</Text><Text selectable style={s.detail}>{receipt.detail}</Text>{receipt.configureAI && <Pressable accessibilityRole="button" onPress={() => useMail.getState().setTab('settings')} style={s.hit}><Text style={s.link}>去配置 AI</Text></Pressable>}<View style={{ flexDirection: 'row', gap: 20, flexWrap: 'wrap' }}>{receipt.undo && <Pressable accessibilityRole="button" disabled={busy || undoing} onPress={() => { if (undoLock.current) return; undoLock.current = true; setUndoing(true); const undo = receipt.undo!; void undo().then(() => { useAgent.setState({ receipt: { title: '已撤销', detail: '已恢复这次工作流产生的可撤销改动。' } }); notice('已撤销') }).catch(e => notice(String(e))).finally(() => { undoLock.current = false; setUndoing(false) }) }} style={s.hit}><Text style={s.link}>撤销本次操作</Text></Pressable>}<Pressable accessibilityRole="button" onPress={() => useMail.getState().setTab('today')} style={s.hit}><Text style={s.link}>查看今日</Text></Pressable></View></View>}
    {cards.map(card => <Pressable key={card.id} accessibilityRole="button" accessibilityLabel={card.title} disabled={busy || undoing} onPress={() => start(card.id)} style={({ pressed }) => [s.card, (card.id === 'plan' || card.id === 'brief') && { borderLeftColor: T.ai, borderLeftWidth: 3 }, (busy || pressed) && { opacity: 0.55 }]}><View style={[s.recipeIcon, (card.id === 'plan' || card.id === 'brief') && { backgroundColor: T.aiSoft }]}><Icon name={card.id === 'plan' || card.id === 'brief' ? 'sparkles' : card.id === 'schedule' ? 'today' : 'mail'} size={21} /></View><View style={{ flex: 1, gap: 5 }}><Text style={s.tag}>{card.tag}</Text><Text style={s.cardTitle}>{card.title}</Text><Text style={s.detail}>{card.text}</Text></View><Icon name="arrow" size={17} color={T.faint} /></Pressable>)}
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => useMail.getState().setTab('settings')} style={s.hit}><Text style={s.link}>配置 AI 接口与模型</Text></Pressable>
  </ScrollView>
}
const s = themedStyles(() => StyleSheet.create({ root: { flex: 1, backgroundColor: T.paper }, body: { padding: 22, paddingBottom: 48, maxWidth: 760, width: '100%', alignSelf: 'center', gap: 12 }, header: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 }, eyebrow: { color: T.faint, fontSize: 12, marginBottom: 6 }, title: { color: T.ink, fontSize: 28, fontWeight: '700' }, scope: { backgroundColor: T.surfaceAlt, borderRadius: 12, padding: 12, gap: 4 }, scopeTitle: { color: T.ink, fontSize: 15, fontWeight: '600' }, hint: { color: T.faint, fontSize: 12, lineHeight: 20 }, card: { backgroundColor: T.surface, padding: 16, borderRadius: 14, gap: 12, flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline }, recipeIcon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: T.surfaceAlt }, recipeLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6 }, tag: { color: T.accent, fontSize: 11 }, cardTitle: { color: T.ink, fontSize: 17, fontWeight: '600' }, detail: { color: T.inkSoft, fontSize: 13, lineHeight: 21 }, link: { color: T.accent, fontSize: 13, fontWeight: '600' }, hit: { minHeight: 44, justifyContent: 'center' }, receipt: { padding: 18, borderRadius: 18, gap: 12, backgroundColor: T.accentSoft } }))
