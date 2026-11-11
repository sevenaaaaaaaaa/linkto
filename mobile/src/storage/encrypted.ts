import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { gcm } from '@noble/ciphers/aes.js'
import { linkToCore } from '../native/LinkToCore'
import { binaryFromBytes, bytesFromBinary, decodeUtf8Bytes } from '../imap/encoding'

export const utf8 = (text: string) => Uint8Array.from(unescape(encodeURIComponent(text)), c => c.charCodeAt(0))
export const b64 = (bytes: Uint8Array) => btoa(binaryFromBytes(bytes))
export const unb64 = (text: string) => bytesFromBinary(atob(text))
export const randomBytes = async (length: number) => unb64(await linkToCore.randomB64(Math.max(length, 16))).slice(0, length)

const queues = new Map<string, Promise<unknown>>()
export function serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(name) ?? Promise.resolve()).then(fn, fn)
  queues.set(name, next.catch(() => undefined))
  return next
}

export function encryptedStore<T>(name: string, empty: () => T) {
  const storageKey = `linkto.${name}.v1`
  const service = `linkto.${name}.key`
  const key = async () => {
    const saved = await Keychain.getGenericPassword({ service })
    if (saved) return unb64(saved.password)
    if (await AsyncStorage.getItem(storageKey)) throw new Error('本机数据密钥不可用，已保留原数据，请先恢复钥匙串')
    const bytes = await randomBytes(32)
    await Keychain.setGenericPassword(name, b64(bytes), { service })
    return bytes
  }
  return {
    async read(): Promise<T> {
      const raw = await AsyncStorage.getItem(storageKey)
      if (!raw) return empty()
      const data = JSON.parse(raw) as { v: number; nonce: string; ciphertext: string }
      if (data.v !== 1) throw new Error('不支持的本机数据版本')
      const bytes = await key()
      try { return JSON.parse(decodeUtf8Bytes(gcm(bytes, unb64(data.nonce), utf8(storageKey)).decrypt(unb64(data.ciphertext)))) as T }
      finally { bytes.fill(0) }
    },
    async write(value: T): Promise<void> {
      const bytes = await key()
      try {
        const nonce = await randomBytes(12)
        const ciphertext = gcm(bytes, nonce, utf8(storageKey)).encrypt(utf8(JSON.stringify(value)))
        await AsyncStorage.setItem(storageKey, JSON.stringify({ v: 1, nonce: b64(nonce), ciphertext: b64(ciphertext) }))
      } finally { bytes.fill(0) }
    }
  }
}
