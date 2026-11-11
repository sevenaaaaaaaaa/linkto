import { useEffect } from 'react'
import { ActivityIndicator, StatusBar, useColorScheme, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useMail } from './src/store/mail'
import { GuardScreen } from './src/screens/GuardScreen'
import { MainShell } from './src/screens/MainShell'
import { T } from './src/theme'

/** 林可兔移动版 v0.6：守卫 → 邮件 / 今日 / 随手记 / 更多 */
export default function App() {
  const dark = useColorScheme() === 'dark'
  const { guard, init } = useMail()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      {guard === 'unknown' ? (
        <View style={{ flex: 1, backgroundColor: T.paper, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={T.accent} />
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
