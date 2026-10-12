import { useRef } from 'react'
import { Animated, Easing, PanResponder, View } from 'react-native'
import { T } from '../theme'
import { useMail } from '../store/mail'
import { linkToCore } from '../native/LinkToCore'

/**
 * 阅读页横滑 · 左右手势切换上一封/下一封（手机与平板右栏同一交互）
 * 判定水平位移优先，不与纵向滚动冲突；到边界轻震提示
 */
export function SwipeReader({ children }: { children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(1)).current

  const flip = (dir: 1 | -1) => {
    const { messages, reading, stepReading } = useMail.getState()
    if (!reading || !messages.length) return
    const i = messages.findIndex(m => m.uid === reading.uid)
    if (!messages[i + dir]) {
      void linkToCore.haptic('warn')
      return
    }
    void linkToCore.haptic('light')
    // 先淡出切换，再淡入
    Animated.timing(opacity, {
      toValue: 0,
      duration: 90,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true
    }).start(() => {
      void stepReading(dir)
      Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }).start()
    })
  }

  const pan = useRef(
    PanResponder.create({
      // capture 阶段判定水平意图：祖先直接接管，避免被 ScrollView 抢占
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 2.2,
      onPanResponderRelease: (_, g) => {
        if (g.dx < -64) flip(1) // 左滑 = 下一封
        else if (g.dx > 64) flip(-1) // 右滑 = 上一封
      }
    })
  ).current

  return (
    <Animated.View style={{ flex: 1, opacity }}>
      <View style={{ flex: 1 }} {...pan.panHandlers}>
        {children}
      </View>
    </Animated.View>
  )
}

/** 阅读页底部手势提示条（对齐桌面端快捷键提示的气质） */
export function SwipeHint() {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 22, height: 2, borderRadius: 1, backgroundColor: T.hairline }} />
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: T.hairline }} />
        <View style={{ width: 22, height: 2, borderRadius: 1, backgroundColor: T.hairline }} />
      </View>
    </View>
  )
}