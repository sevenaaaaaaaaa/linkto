import { useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useMail } from './src/store/mail'
import { GuardScreen } from './src/screens/GuardScreen'
import { MainShell } from './src/screens/MainShell'

/** 林可兔移动版 v0.4：守卫 → 多账户邮件 / 加密 / 保险箱 / 设置 */
export default function App() {
  const { guard, init } = useMail()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <SafeAreaProvider>
      {guard === 'unknown' ? (
        <View style={{ flex: 1, backgroundColor: '#F5F1E8', alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color="#007C78" />
        </View>
      ) : guard === 'setup' ? (
        <GuardScreen mode="setup" />
      ) : guard === 'locked' || guard === 'burned' ? (
        <GuardScreen mode="locked" />
      ) : (
        <MainShell />
      )}
    </SafeAreaProvider>
  )
}
