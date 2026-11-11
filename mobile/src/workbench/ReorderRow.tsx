import { useRef, useState } from 'react'
import { Animated, PanResponder, Text, View } from 'react-native'
import { T } from '../theme'
import { reorderTarget } from './planning'
export function ReorderRow({ children, index, heights, enabled, onDrop, onDragging }: { children: React.ReactNode; index: number; heights: number[]; enabled: boolean; onDrop(target: number): void; onDragging(active: boolean): void }) {
  const dy = useRef(new Animated.Value(0)).current, refs = useRef({ index, heights, onDrop, onDragging })
  const [active, setActive] = useState(false)
  refs.current = { index, heights, onDrop, onDragging }
  const stop = (distance: number) => { const ref = refs.current; setActive(false); ref.onDragging(false); const target = reorderTarget(ref.index, distance, ref.heights); dy.setValue(0); if (target !== ref.index) ref.onDrop(target) }
  const pan = useRef(PanResponder.create({ onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true, onPanResponderGrant: () => { setActive(true); refs.current.onDragging(true) }, onPanResponderMove: (_, gesture) => dy.setValue(gesture.dy), onPanResponderRelease: (_, gesture) => stop(gesture.dy), onPanResponderTerminate: () => stop(0) })).current
  return <Animated.View onLayout={event => { heights[index] = event.nativeEvent.layout.height }} style={{ zIndex: active ? 10 : 0, transform: [{ translateY: dy }], opacity: active ? 0.88 : 1, flexDirection: 'row' }}>
    {enabled && <View {...pan.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel="拖动任务调整顺序并重新排程" accessibilityActions={[{ name: 'increment', label: '下移' }, { name: 'decrement', label: '上移' }]} onAccessibilityAction={e => onDrop(Math.max(0, Math.min(heights.length - 1, index + (e.nativeEvent.actionName === 'increment' ? 1 : -1))))} style={{ width: 44, minHeight: 48, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: active ? T.accent : T.faint, fontSize: 21 }}>≡</Text></View>}
    <View style={{ flex: 1 }}>{children}</View>
  </Animated.View>
}
