import { encryptedStore, serial } from './storage/encrypted'
import type { MailBody, MobileMessage } from './store/mail'

interface Cache { messages: MobileMessage[]; bodies: Record<string, MailBody> }
const disk = encryptedStore<Cache>('mail-cache', () => ({ messages: [], bodies: {} }))
export const messageKey = (m: Pick<MobileMessage, 'accountId' | 'mailbox' | 'uid'>) => `${m.accountId}:${m.mailbox}:${m.uid}`
export const readMailCache = () => serial('mail-cache', () => disk.read())
export const saveMailList = (accountId: string, mailbox: string, list: MobileMessage[]) => serial('mail-cache', async () => {
  const cache = await disk.read()
  const messages = [...cache.messages.filter(m => m.accountId !== accountId || m.mailbox !== mailbox), ...list].slice(-1200)
  await disk.write({ ...cache, messages })
})
export const saveMailBody = (m: MobileMessage, body: MailBody) => serial('mail-cache', async () => {
  const cache = await disk.read()
  const entries = Object.entries(cache.bodies).filter(([key]) => key !== messageKey(m)).slice(-39)
  const bodies = Object.fromEntries([...entries, [messageKey(m), { ...body, attachments: body.attachments.map(({ data, ...metadata }) => metadata), html: body.html?.slice(0, 500000) ?? null, text: body.text?.slice(0, 250000) ?? null }]])
  await disk.write({ ...cache, bodies })
})
export const forgetCachedAccount = (id: string) => serial('mail-cache', async () => {
  const cache = await disk.read()
  await disk.write({ messages: cache.messages.filter(m => m.accountId !== id), bodies: Object.fromEntries(Object.entries(cache.bodies).filter(([key]) => !key.startsWith(id + ':'))) })
})
