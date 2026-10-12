import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useMail } from './src/store/mail'
import { AccountsScreen } from './src/screens/AccountsScreen'
import { InboxScreen } from './src/screens/InboxScreen'
import { ReadScreen } from './src/screens/ReadScreen'
import { GuardScreen } from './src/screens/GuardScreen'

/** 林可兔移动版 v0.3：原生安全内核（LinkToCore）→ 守卫 → 账户 / 收件箱 / 阅读 */
export default function App() {
  const { screen, guard, init } = useMail()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <SafeAreaProvider>
      {guard === 'setup' ? (
        <GuardScreen mode="setup" />
      ) : guard === 'locked' || guard === 'burned' ? (
        <GuardScreen mode="locked" />
      ) : screen === 'inbox' ? (
        <InboxScreen />
      ) : screen === 'read' ? (
        <ReadScreen />
      ) : (
        <AccountsScreen />
      )}
    </SafeAreaProvider>
  )
}