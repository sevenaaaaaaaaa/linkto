import { useEffect, useState } from 'react'
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { T } from '../theme'
import { useMail } from '../store/mail'

/**
 * 守卫屏：首次设置主密码 / 每次启动解锁
 * 阶梯焚毁：错 5 次锁 15 分钟（翻倍递增），累计 15 次 → 焚毁全部本地数据
 */
export function GuardScreen({ mode }: { mode: 'setup' | 'locked' }) {
  const { setupMaster, unlockMaster, guardFailsLeft, guardLockUntil, burnReason, init } = useMail()
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [, force] = useState(0)

  // 锁定期倒计时
  useEffect(() => {
    if (guardLockUntil <= Date.now()) return
    const t = setInterval(() => force(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [guardLockUntil])

  const locked = guardLockUntil > Date.now()
  const remainMin = Math.ceil((guardLockUntil - Date.now()) / 60000)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setErr('')
    if (mode === 'setup') {
      if (pass !== pass2) {
        setErr('两次输入不一致')
        setBusy(false)
        return
      }
      const problem = await setupMaster(pass)
      if (problem) setErr(problem)
    } else {
      await unlockMaster(pass)
    }
    setPass('')
    setPass2('')
    setBusy(false)
  }

  return (
    <SafeAreaView style={s.root}>
      {burnReason ? (
        <View style={s.burnBanner}>
          <Text style={s.burnText}>☠ {burnReason}</Text>
          <TouchableOpacity style={s.restartBtn} onPress={() => void init()}>
            <Text style={s.restartText}>重新开始（重新设置主密码）</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <Text style={s.title}>{mode === 'setup' ? '设置主密码' : '林可兔已锁定'}</Text>
      <Text style={s.sub}>
        {mode === 'setup'
          ? '主密码保护本机全部邮件凭据。错 5 次锁定 15 分钟，累计 15 次本地数据永久焚毁——请牢记。'
          : `输入主密码解锁。剩余尝试 ${guardFailsLeft} 次（${guardFailsLeft} 次后焚毁）`}
      </Text>
      <TextInput
        style={s.input}
        placeholder="主密码"
        placeholderTextColor={T.faint}
        secureTextEntry
        value={pass}
        onChangeText={setPass}
        onSubmitEditing={() => void submit()}
      />
      {mode === 'setup' && (
        <TextInput
          style={s.input}
          placeholder="再输一遍确认"
          placeholderTextColor={T.faint}
          secureTextEntry
          value={pass2}
          onChangeText={setPass2}
          onSubmitEditing={() => void submit()}
        />
      )}
      {err !== '' && <Text style={s.err}>{err}</Text>}
      {locked && <Text style={s.err}>锁定期：还需等待 {remainMin} 分钟（连错触发阶梯锁定）</Text>}
      <TouchableOpacity
        style={[s.btn, (busy || locked || !pass) && { opacity: 0.5 }]}
        disabled={busy || locked || !pass}
        onPress={() => void submit()}
      >
        <Text style={s.btnText}>{busy ? '验证中…' : mode === 'setup' ? '设置并进入' : '解锁'}</Text>
      </TouchableOpacity>
      <Text style={s.note}>
        凭据存于系统钥匙串（Keychain / Keystore）。TLS 证书校验失败（中间人）将立即焚毁全部本地数据。
      </Text>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper, paddingHorizontal: 24 },
  burnBanner: { backgroundColor: T.danger, borderRadius: 10, padding: 12, marginTop: 12 },
  burnText: { color: '#fff', fontSize: 13, fontWeight: '600', lineHeight: 19 },
  restartBtn: { marginTop: 8, alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  restartText: { color: '#fff', fontSize: 12 },
  title: { fontSize: 22, fontWeight: '700', color: T.ink, marginTop: 40 },
  sub: { fontSize: 12, color: T.faint, marginTop: 8, lineHeight: 18, marginBottom: 20 },
  input: { backgroundColor: T.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: T.hairline, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: T.ink, marginBottom: 12 },
  err: { fontSize: 12, color: T.danger, marginBottom: 10, lineHeight: 17 },
  btn: { backgroundColor: T.accent, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  btnText: { color: T.accentInk, fontSize: 14, fontWeight: '600' },
  note: { fontSize: 11, color: T.faint, marginTop: 16, lineHeight: 16 }
})