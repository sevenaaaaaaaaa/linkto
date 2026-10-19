import { ipcMain } from 'electron'
import type { MailStore } from './db'
import { pinyinKeys } from './pinyin'

/**
 * 搜索索引状态 / 拼音键（独立注册 api:search* / api:pinyin* 通道，不改动既有处理器表）。
 */
export function registerSearchIpc(store: MailStore) {
  ipcMain.handle('api:searchIndexStatus', () => store.search.status())
  ipcMain.handle('api:pinyinKeys', (_e, texts: unknown, asNames?: unknown) => {
    if (!Array.isArray(texts)) return []
    return pinyinKeys(texts.slice(0, 2000).map(t => (typeof t === 'string' ? t : '')), asNames === true)
  })
}
