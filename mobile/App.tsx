import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useMail } from './src/store/mail'
import { AccountsScreen } from './src/screens/AccountsScreen'
import { InboxScreen } from './src/screens/InboxScreen'
import { ReadScreen } from './src/screens/ReadScreen'

/** 林可兔移动版 v0.1：账户 / 收件箱 / 阅读 三屏（手写路由，零额外依赖） */
export default function App() {
  const { screen, init } = useMail()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <SafeAreaProvider>
      {screen === 'inbox' ? (
        <InboxScreen />
      ) : screen === 'read' ? (
        <ReadScreen />
      ) : (
        <AccountsScreen />
      )}
    </SafeAreaProvider>
  )
}