/**
 * 设置窗「定位到某个账户」：主窗口用 openSettings('accounts:<id>[:reauth|:password]') 打开，
 * SettingsApp 解析后存到这里，AccountsTab 挂载时 / 收到事件时领取（选中该账户，并可直接进入重新授权或重输密码）
 */
export interface AccountFocus {
  accountId: string
  action?: 'reauth' | 'password'
}

let pending: AccountFocus | null = null

/** 解析 tab 参数：返回真实页面 id，并登记账户定位 */
export function parseSettingsTab(raw: string): string {
  const [tab, accountId, action] = raw.split(':')
  if (tab === 'accounts' && accountId) {
    pending = { accountId, action: action === 'reauth' || action === 'password' ? action : undefined }
    window.dispatchEvent(new CustomEvent('ms:settings-focus-account'))
  }
  return tab
}

export function takeAccountFocus(): AccountFocus | null {
  const f = pending
  pending = null
  return f
}
