import { useEffect, useRef } from 'react'
import { Animated, Easing, Modal, StyleSheet, Text, Vibration, View } from 'react-native'
import { T } from '../theme'
import type { MailEnvelope } from '../imap/ImapLite'

/**
 * 玻璃速览 · 长按列表行弹出（对应桌面端按住 ⌥ 的玻璃透镜）
 * 速览卡片：纸面浮层 + 铜绿未读点，缩放入场，轻触感反馈
 * 轻触任意处（含卡片）关闭 —— 与桌面端玻璃透镜点击任意处关闭一致
 */
export function LensPeek({ msg, onClose }: { msg: MailEnvelope | null; onClose(): void }) {
  const anim = useRef(new Animated.Value(0)).current
  const openedAt = useRef(0)
  useEffect(() => {
    if (msg) {
      openedAt.current = Date.now()
      Vibration.vibrate(10)
      Animated.timing(anim, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.back(1.4)),
        useNativeDriver: true
      }).start()
    } else {
      anim.setValue(0)
    }
  }, [msg, anim])

  // 长按抬起的残留触摸事件会在弹层挂载后立刻到达：开启后 600ms 内忽略关闭，防"秒关"
  const handleClose = () => {
    if (Date.now() - openedAt.current < 600) return
    onClose()
  }

  if (!msg) return null
  const unread = !msg.flags.includes('\\Seen')
  return (
    <Modal transparent visible onRequestClose={handleClose} animationType="none" statusBarTranslucent>
      {/* 原始 onTouchEnd 而非 Pressable：Fabric 下 Modal 内 Pressable 触摸派发不可靠 */}
      <Animated.View
        style={[s.scrim, { opacity: anim }]}
        onTouchEnd={handleClose}
        accessibilityLabel="关闭速览"
      >
        <Animated.View
          style={[
            s.card,
            { transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }
          ]}
        >
          <View style={s.rowHead}>
            {unread && <View style={s.dot} />}
            <Text style={s.date} numberOfLines={1}>
              {msg.date ? new Date(msg.date).toLocaleString('zh-CN', { hour12: false }) : ''}
            </Text>
          </View>
          <Text style={s.subject} numberOfLines={3}>{msg.subject || '（无主题）'}</Text>
          <View style={s.divider} />
          <Text style={s.from} numberOfLines={1}>{msg.from || '(未知发件人)'}</Text>
          <Text style={s.hint}>轻触任意处关闭</Text>
        </Animated.View>
      </Animated.View>
    </Modal>
  )
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(31,34,38,0.32)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: T.surface,
    borderRadius: 20,
    padding: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.hairline,
    gap: 8
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.accent },
  date: { fontSize: 11, color: T.faint, flex: 1, textAlign: 'right' },
  subject: { fontSize: 17, fontWeight: '700', color: T.ink, lineHeight: 24 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: T.hairline },
  from: { fontSize: 13, color: T.accent, fontWeight: '600' },
  hint: { fontSize: 10, color: T.faint, marginTop: 6, textAlign: 'center' }
})