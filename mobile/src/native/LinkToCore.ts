import { NativeModules, Platform, Vibration } from 'react-native'
import { sha256Hex as jsSha256Hex } from '../security/sha256'

/**
 * LinkToCore —— 原生能力模块的 JS 访问层（v0.3.0 原生改造）
 *
 * 原生实现（Android Kotlin / iOS ObjC+CommonCrypto）：
 *  - sha256Hex   平台原生 SHA-256
 *  - randomB64   SecureRandom / SecRandomCopyBytes（密码学安全随机）
 *  - pbkdf2Hex   PBKDF2-HMAC-SHA256（守卫验证器 KDF，抗离线暴力）
 *  - haptic      平台原生触感反馈（Android VibrationEffect 预设 / iOS 触感引擎）
 *
 * 降级策略：测试环境（jest）或模块缺失时退回 JS 实现，保证守卫逻辑可用。
 */

interface LinkToCoreNative {
  sha256Hex(msg: string): Promise<string>
  randomB64(len: number): Promise<string>
  pbkdf2Hex(password: string, salt: string, iterations: number): Promise<string>
  haptic(kind: 'light' | 'medium' | 'heavy' | 'warn'): Promise<boolean>
}

const native = NativeModules.LinkToCore as LinkToCoreNative | undefined

export const linkToCore = {
  /** 原生 SHA-256；无原生模块时退回 JS 实现 */
  sha256Hex: (msg: string): Promise<string> =>
    native ? native.sha256Hex(msg) : Promise.resolve(jsSha256Hex(msg)),

  /** 密码学安全随机（b64）。降级：JS Math.random（仅测试环境） */
  randomB64: (len = 32): Promise<string> => {
    if (native) return native.randomB64(len)
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256)
    return Promise.resolve(btoa(String.fromCharCode(...Array.from(bytes))))
  },

  /** PBKDF2-HMAC-SHA256。无原生能力返回 null（调用方降级 v1 验证器） */
  pbkdf2Hex: async (password: string, salt: string, iterations = 60_000): Promise<string | null> =>
    native ? native.pbkdf2Hex(password, salt, iterations) : null,

  /** 原生触感反馈。降级：RN Vibration（Android 通用振动） */
  haptic: async (kind: 'light' | 'medium' | 'heavy' | 'warn' = 'light'): Promise<void> => {
    if (native) {
      await native.haptic(kind)
      return
    }
    if (Platform.OS === 'android') Vibration.vibrate(kind === 'heavy' ? 30 : kind === 'warn' ? 50 : 8)
    else Vibration.vibrate(kind === 'heavy' ? 30 : 8)
  },

  /** 是否有原生模块（守卫据此选择 KDF 版本） */
  hasNative: (): boolean => !!native
}