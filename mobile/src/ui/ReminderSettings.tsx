import { useEffect, useState } from 'react'
import { AppState, Linking, Platform, Pressable, Text, View } from 'react-native'
import { linkToCore } from '../native/LinkToCore'
import { T } from '../theme'
export function ReminderSettings() {
  const [status, setStatus] = useState({ authorized: true, exact: true })
  useEffect(() => { const load = () => { void linkToCore.reminderStatus().then(setStatus) }; load(); const listener = AppState.addEventListener('change', state => { if (state === 'active') load() }); return () => listener.remove() }, [])
  return <View style={{ padding: 18, borderRadius: 18, backgroundColor: T.surface, gap: 10 }}><Text style={{ color: T.ink, fontWeight: '600', fontSize: 16 }}>提醒与收信</Text><Text style={{ color: T.faint, fontSize: 12, lineHeight: 20 }}>待办到时可由系统提醒；邮件在应用前台自动接收。新邮件远程推送尚未启用。</Text>
    {Platform.OS === 'android' && <><Text style={{ color: T.faint, fontSize: 12, lineHeight: 20 }}>{!status.authorized ? '通知未允许，请到系统设置开启。' : status.exact ? '已允许精确提醒。' : '当前使用系统弹性提醒，省电模式可能延迟；可允许“闹钟和提醒”提高准时性。'}</Text><Pressable accessibilityRole="button" onPress={() => { void (!status.authorized ? Linking.openSettings() : linkToCore.openReminderSettings()) }} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: T.accent }}>打开系统提醒设置</Text></Pressable></>}
  </View>
}
