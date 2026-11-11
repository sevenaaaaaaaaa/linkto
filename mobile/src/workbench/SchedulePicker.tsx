import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { T, themedStyles } from '../theme'
import { useReducedMotion } from '../hooks/useReducedMotion'

/** Calendar + large time steppers, with a text-input alternative in CaptureSheet. */
export function SchedulePicker({ initial, onSave, onClose }: { initial: number; onSave(at: number): void; onClose(): void }) {
  const [date, setDate] = useState(new Date(initial)), [month, setMonth] = useState(new Date(new Date(initial).getFullYear(), new Date(initial).getMonth(), 1))
  const reduced = useReducedMotion()
  const button = (label: string, fn: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={label} style={s.button} onPress={fn}><Text style={s.link}>{label}</Text></Pressable>
  const shift = (minutes: number) => { const next = new Date(date); next.setMinutes(next.getMinutes() + minutes); setDate(next); setMonth(new Date(next.getFullYear(), next.getMonth(), 1)) }
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  return <Modal visible transparent animationType={reduced ? 'none' : 'fade'} onRequestClose={onClose}><View style={s.overlay}><View style={s.sheet}>
    <View style={s.row}>{button('取消', onClose)}<Text style={s.heading}>安排时间</Text>{button('确定时间', () => onSave(date.getTime()))}</View>
    <View style={s.row}>{button('上个月', () => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1)))}<Text style={s.heading}>{month.getFullYear()} 年 {month.getMonth() + 1} 月</Text>{button('下个月', () => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1)))}</View>
    <View style={s.grid}>{['日', '一', '二', '三', '四', '五', '六'].map(day => <Text key={day} style={s.week}>{day}</Text>)}{Array.from({ length: month.getDay() + count }, (_, n) => {
      const day = n - month.getDay() + 1, selected = date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth() && date.getDate() === day
      return day < 1 ? <View key={n} style={s.day} /> : <Pressable key={n} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${month.getFullYear()}年${month.getMonth() + 1}月${day}日`} style={[s.day, selected && { backgroundColor: T.accentSoft }]} onPress={() => { const next = new Date(month.getFullYear(), month.getMonth(), day, date.getHours(), date.getMinutes()); setDate(next) }}><Text style={{ color: selected ? T.accent : T.ink, fontSize: 16 }}>{day}</Text></Pressable>
    })}</View>
    <Text style={s.time}>{date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</Text>
    <View style={s.row}>{button('−1 小时', () => shift(-60))}{button('−15 分', () => shift(-15))}{button('＋15 分', () => shift(15))}{button('＋1 小时', () => shift(60))}</View>
  </View></View></Modal>
}
const s = themedStyles(() => StyleSheet.create({ overlay: { flex: 1, justifyContent: 'center', backgroundColor: T.scrim, padding: 16 }, sheet: { padding: 12, paddingBottom: 24, borderRadius: 24, backgroundColor: T.surface, width: '100%', maxWidth: 520, alignSelf: 'center' }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }, button: { minWidth: 64, minHeight: 48, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' }, link: { color: T.accent, fontSize: 13 }, heading: { color: T.ink, fontSize: 15, fontWeight: '600' }, grid: { flexDirection: 'row', flexWrap: 'wrap' }, week: { width: '14.2857%', textAlign: 'center', color: T.faint, paddingVertical: 8 }, day: { width: '14.2857%', minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 12 }, time: { color: T.ink, fontSize: 28, fontWeight: '600', textAlign: 'center', marginVertical: 16 } }))
