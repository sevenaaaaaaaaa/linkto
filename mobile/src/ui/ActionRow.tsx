import { useEffect, useRef, useState } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { T, themedStyles } from '../theme'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { linkToCore } from '../native/LinkToCore'
import { isFullDeleteSwipe } from './swipe-policy'

export interface RowAction { label: string; danger?: boolean; run(): void }
/** Horizontal intent only. A full swipe invokes the leading, reversible action. */
export function ActionRow({ children, leading, trailing, disabled = false, fullSwipeTrailing = false }: { children: React.ReactNode; leading?: RowAction; trailing: RowAction[]; disabled?: boolean; fullSwipeTrailing?: boolean }) {
  const x = useRef(new Animated.Value(0)).current
  const [side, setSide] = useState(0)
  const [armed, setArmed] = useState(false)
  const state = useRef({ base: 0, width: 360, disabled, leading, trailing, fullSwipeTrailing, reduced: false, armed: false })
  state.current = { ...state.current, disabled, leading, trailing, fullSwipeTrailing, reduced: useReducedMotion() }
  const snap = (value: number) => {
    state.current.base = value; state.current.armed = false; setArmed(false); setSide(Math.sign(value))
    if (state.current.reduced) x.setValue(value)
    else Animated.spring(x, { toValue: value, speed: 28, bounciness: 3, useNativeDriver: true }).start()
  }
  useEffect(() => { if (disabled) snap(0) }, [disabled])
  const invoke = (action: RowAction) => { if (state.current.disabled) { snap(0); return }; snap(0); void linkToCore.haptic('light'); action.run() }
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, g) => !state.current.disabled && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.7,
    onPanResponderMove: (_, g) => {
      const next = state.current.base + g.dx
      const ready = state.current.fullSwipeTrailing && !!state.current.trailing.length && isFullDeleteSwipe(g.dx, state.current.width, state.current.base)
      if (ready !== state.current.armed) { state.current.armed = ready; setArmed(ready); if (ready) void linkToCore.haptic('light') }
      setSide(Math.sign(next))
      x.setValue(Math.max(state.current.fullSwipeTrailing ? -state.current.width : -state.current.trailing.length * 80 - 20, Math.min(state.current.leading ? 160 : 0, next)))
    },
    onPanResponderRelease: (_, g) => {
      if (state.current.disabled) { snap(0); return }
      const next = state.current.base + g.dx
      if (state.current.fullSwipeTrailing && state.current.trailing.length && isFullDeleteSwipe(g.dx, state.current.width, state.current.base)) invoke(state.current.trailing[state.current.trailing.length - 1])
      else if (next > 135 && state.current.leading) invoke(state.current.leading)
      else if (next > 40 && state.current.leading) snap(80)
      else if (next < -40 && state.current.trailing.length) snap(-80 * state.current.trailing.length)
      else snap(0)
    },
    onPanResponderTerminate: () => snap(0)
  })).current
  const actions = side > 0 && leading ? [leading] : armed ? trailing.slice(-1) : trailing
  return <View onLayout={event => { state.current.width = event.nativeEvent.layout.width }} style={s.clip}>
    <View accessibilityElementsHidden={disabled || !side} importantForAccessibility={disabled || !side ? 'no-hide-descendants' : 'auto'} pointerEvents={disabled || !side ? 'none' : 'auto'} style={[s.actions, { left: 0, right: 0, justifyContent: side > 0 ? 'flex-start' : 'flex-end', backgroundColor: side > 0 ? T.accent : trailing[trailing.length - 1]?.danger ? T.danger : T.accent }]}>
      {actions.map(action => <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.label} onPress={() => invoke(action)} style={[s.action, { backgroundColor: action.danger ? T.danger : T.accent }]}><Text style={s.label}>{action.label}</Text></Pressable>)}
    </View>
    <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }] }}><View style={s.content}>{children}</View></Animated.View>
  </View>
}
const s = themedStyles(() => StyleSheet.create({ clip: { overflow: 'hidden', borderRadius: 12 }, actions: { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row' }, action: { width: 80, minHeight: 48, justifyContent: 'center', alignItems: 'center' }, label: { color: T.accentInk, fontSize: 12, fontWeight: '600' }, content: { backgroundColor: T.paper } }))
