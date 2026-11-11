import { useEffect } from 'react'
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native'
import { create } from 'zustand'
import { themedStyles, T } from '../theme'
const useNotice = create<{ text: string; undo?: () => Promise<void>; busy: boolean }>(() => ({ text: '', busy: false }))
let timer: ReturnType<typeof setTimeout> | null = null
export function notice(text: string, undo?: () => Promise<void>) {
  if (timer) clearTimeout(timer)
  useNotice.setState({ text, undo, busy: false })
  AccessibilityInfo.announceForAccessibility(undo ? `${text}，可撤销` : text)
  timer = setTimeout(() => useNotice.setState({ text: '', undo: undefined }), 10000)
}
export function Notice() {
  const state = useNotice()
  useEffect(() => () => { if (timer) clearTimeout(timer); useNotice.setState({ text: '', undo: undefined }) }, [])
  if (!state.text) return null
  return <View style={s.bar} accessibilityLiveRegion="polite"><Text style={s.text}>{state.text}</Text>{state.undo && <Pressable accessibilityRole="button" disabled={state.busy} style={s.undo} onPress={() => {
    if (timer) clearTimeout(timer)
    useNotice.setState({ busy: true })
    void state.undo!().then(() => notice('已撤销')).catch(e => notice(e instanceof Error ? e.message : '撤销未完成，请刷新检查'))
  }}><Text style={s.action}>{state.busy ? '恢复中…' : '撤销'}</Text></Pressable>}</View>
}
const s = themedStyles(() => StyleSheet.create({ bar: { position: 'absolute', bottom: 12, left: 16, right: 16, borderRadius: 14, backgroundColor: T.surfaceAlt, borderWidth: 1, borderColor: T.hairline, paddingLeft: 16, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', minHeight: 52 }, text: { flex: 1, color: T.ink, fontSize: 13 }, undo: { paddingHorizontal: 18, minHeight: 44, justifyContent: 'center' }, action: { color: T.accent, fontWeight: '600' } }))
