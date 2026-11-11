/** RFC 3501 modified UTF-7. Never send Unicode names as unnegotiated UTF-8. */
export function encodeMailbox(name: string): string {
  return name.replace(/&|[^\x20-\x7e]+/g, run => {
    if (run === '&') return '&-'
    let binary = ''
    for (let i = 0; i < run.length; i++) { const n = run.charCodeAt(i); binary += String.fromCharCode(n >> 8, n & 255) }
    return '&' + btoa(binary).replace(/\//g, ',').replace(/=+$/, '') + '-'
  })
}
export function decodeMailbox(name: string): string {
  return name.replace(/&([A-Za-z0-9+,]*)-/g, (encoded, text: string) => {
    if (!text) return '&'
    try {
      const bytes = atob(text.replace(/,/g, '/') + '='.repeat((4 - text.length % 4) % 4))
      if (bytes.length % 2) return encoded
      let result = ''
      for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode(bytes.charCodeAt(i) * 256 + bytes.charCodeAt(i + 1))
      return result
    } catch { return encoded }
  })
}
export function validateMailbox(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 180 || /[\x00-\x1f\x7f*%]/.test(trimmed)) throw new Error('文件夹名称不能为空、超过 180 字或包含控制字符、*、%')
  if (/(?:^|[/.])LinkTo-Sync(?:[/.]|$)/i.test(trimmed)) throw new Error('LinkTo-Sync 是加密同步保留的文件夹名称')
  return trimmed
}
export function protectedMailbox(folder: { name: string; flags: string[] }): boolean {
  return /^INBOX$/i.test(folder.name) || /(?:^|[/.])LinkTo-Sync$/i.test(folder.name) || folder.flags.some(f => /^\\(?:Inbox|All|Archive|Trash|Junk|Sent|Drafts|Flagged|Important|Noselect)$/i.test(f)) || /^(?:Archive|Archives|Trash|Drafts|Sent|Junk|Spam|Deleted Items|收件箱|草稿箱|已发送|垃圾箱|归档)$/i.test(folder.name.split(/[/.]/).pop() ?? '')
}
