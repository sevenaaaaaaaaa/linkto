import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { encryptedStore, serial } from '../storage/encrypted'
export interface RestoreJournal { values: Array<[string, string | null]>; secrets: Array<{ service: string; username?: string; password: string | null }> }
export const restoreJournal = encryptedStore<RestoreJournal | null>('restore-journal', () => null)
export async function rollbackRestore(snapshot: RestoreJournal) {
  for (const [key, value] of snapshot.values) {
    if (value == null) await AsyncStorage.removeItem(key)
    else await AsyncStorage.setItem(key, value)
  }
  for (const secret of snapshot.secrets) {
    if (secret.password == null) await Keychain.resetGenericPassword({ service: secret.service })
    else await Keychain.setGenericPassword(secret.username ?? 'restored', secret.password, { service: secret.service })
  }
  await restoreJournal.write(null)
}
/** Recovery precedes the unlock screen; a wiped guard must never be resurrected. */
export const recoverPendingRestore = (initialized: boolean) => serial('backup-restore', async () => {
  const snapshot = await restoreJournal.read()
  if (!snapshot) return
  if (initialized) await rollbackRestore(snapshot)
  else await restoreJournal.write(null)
})
