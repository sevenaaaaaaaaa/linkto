import { View, Text, StyleSheet } from 'react-native'
import Svg, { Path, Circle, G, Rect } from 'react-native-svg'
import { T, themedStyles } from '../theme'
/** Canonical desktop build/logo.svg geometry. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 120 120" accessible={false}><Rect width={120} height={120} rx={28} fill="#0E1116" /><G fill="none" stroke="#F4F5F7" strokeWidth={8} strokeLinecap="round"><Path d="M101.4 52.7A42 42 0 1 0 60 102L94 102" /><Path d="M81.8 70.1A24 24 0 1 1 81.8 49.9" /></G><Circle cx={60} cy={60} r={9} fill="#D7F23C" /></Svg>
}
export function Brand({ subtitle, large = false }: { subtitle?: string; large?: boolean }) {
  return <View style={s.row}><BrandMark size={large ? 52 : 36} /><View style={{ flex: 1 }}><Text style={[s.wordmark, large && { fontSize: 28 }]}>LinkTo<Text style={s.name}> 林可兔</Text></Text>{!!subtitle && <Text style={s.subtitle}>{subtitle}</Text>}</View></View>
}
const s = themedStyles(() => StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, wordmark: { color: T.ink, fontSize: 22, fontWeight: '700', letterSpacing: -0.8 }, name: { color: T.faint, fontSize: 12, fontWeight: '400', letterSpacing: 0 }, subtitle: { color: T.faint, fontSize: 12, lineHeight: 19, marginTop: 3 } }))
