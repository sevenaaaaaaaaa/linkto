import { useRef, useState } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { T } from '../theme'
import { linkToCore } from '../native/LinkToCore'

const ACTIONS_W = 84

/**
 * 左滑行 · 快捷动作（移动端标志性触控交互，对齐桌面端列表行内操作）
 * - 左滑露出「已读⇄未读」动作钮，吸附/回弹带弹簧动画，触发轻触感反馈
 * - 轻点开邮件，长按弹出玻璃速览（LensPeek）
 */
export function SwipeRow({
  seen,
  onPress,
  onLongPress,
  onToggle,
  children
}: {
  seen: boolean
  onPress(): void
  onLongPress(): void
  onToggle(): void
  children: React.ReactNode
}) {
  const translate = useRef(new Animated.Value(0)).current
  const base = useRef(0)
  const [open, setOpen] = useState(false)

  const snapTo = (v: number, openNext: boolean) => {
    base.current = v
    setOpen(openNext)
    Animated.spring(translate, {
      toValue: v,
      speed: 24,
      bounciness: 6,
      useNativeDriver: true
    }).start()
  }

  const pan = useRef(
    PanResponder.create({
      // capture 阶段判定水平意图：祖先直接接管，避免被子组件抢占
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderMove: (_, g) => {
        const next = Math.min(0, Math.max(-ACTIONS_W - 24, base.current + g.dx))
        translate.setValue(next)
      },
      onPanResponderRelease: (_, g) => {
        const x = base.current + g.dx
        if (x < -ACTIONS_W / 2 || g.vx < -0.4) {
          if (!open) void linkToCore.haptic('light')
          snapTo(-ACTIONS_W, true)
        } else {
          snapTo(0, false)
        }
      },
      onPanResponderTerminate: () => snapTo(0, false)
    })
  ).current

  return (
    <View style={s.clip}>
      {/* 动作区（行内容右滑让位后露出） */}
      <View style={s.actions}>
        <Pressable
          style={s.actionBtn}
          onPress={() => {
            void linkToCore.haptic('light')
            onToggle()
            snapTo(0, false)
          }}
        >
          <Text style={s.actionText}>{seen ? '标为未读' : '标为已读'}</Text>
        </Pressable>
      </View>
      <Animated.View style={{ transform: [{ translateX: translate }] }} {...pan.panHandlers}>
        <Pressable
          onPress={() => (open ? snapTo(0, false) : onPress())}
          onLongPress={onLongPress}
          delayLongPress={350}
          disabled={open}
          android_ripple={{ color: T.hairline }}
          style={s.content}
        >
          {children}
        </Pressable>
      </Animated.View>
    </View>
  )
}

const s = StyleSheet.create({
  clip: { overflow: 'hidden', borderRadius: 10 },
  actions: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'flex-end',
    justifyContent: 'center'
  },
  actionBtn: {
    width: ACTIONS_W,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: T.accent,
    borderRadius: 10
  },
  actionText: { color: T.accentInk, fontSize: 12, fontWeight: '700' },
  content: { backgroundColor: T.paper }
})