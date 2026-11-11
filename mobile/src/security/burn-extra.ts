import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { linkToCore } from '../native/LinkToCore'

/**
 * 守卫焚毁时一并清掉 v0.4 新增的本地秘密：
 *  - 保险箱数据密钥（Keychain）
 *  - 保险箱密文表（AsyncStorage）
 *  - AI Key（Keychain）
 *  - 账户索引（AsyncStorage；guard 也会清，双保险）
 * 失败用 allSettled：焚毁是尽力而为，不能因为某一项失败阻断其他项。
 */
export async function burnExtraSecrets(): Promise<void> {
  await Promise.allSettled([
    linkToCore.cancelAllReminders(),
    linkToCore.clearAttachments(),
    Keychain.resetGenericPassword({ service: 'linkto.vault.key' }),
    Keychain.resetGenericPassword({ service: 'linkto.ai.key' }),
    Keychain.resetGenericPassword({ service: 'linkto.workbench.key' }),
    Keychain.resetGenericPassword({ service: 'linkto.planning.key' }),
    Keychain.resetGenericPassword({ service: 'linkto.mail-cache.key' }),
    Keychain.resetGenericPassword({ service: 'linkto.workbench.sync' }),
    AsyncStorage.removeItem('linkto.workbench.v1'),
    AsyncStorage.removeItem('linkto.planning.v1'),
    AsyncStorage.removeItem('linkto.mail-cache.v1'),
    AsyncStorage.removeItem('linkto.vault.v1'),
    AsyncStorage.removeItem('linkto.accounts.v1')
  ])
}
