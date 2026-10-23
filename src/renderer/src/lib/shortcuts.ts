/** 全局键盘快捷键：命令面板 / 快捷键面板 / 个性化页共用一份数据 */
export interface ShortcutItem {
  keys: string
  label: string
  /** 额外搜索词，不显示 */
  aliases?: string
}

export interface ShortcutGroup {
  title: string
  items: ShortcutItem[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '全局',
    items: [
      { keys: '⌘K', label: '命令面板 · 搜索或直接提问', aliases: 'command palette 命令' },
      { keys: '?', label: '键盘快捷键', aliases: 'help 帮助 快捷键' },
      { keys: '⌘F', label: '聚焦邮件搜索', aliases: 'search 搜索' },
      { keys: '⌘N', label: '写邮件', aliases: 'compose 新邮件' },
      { keys: '⌘R', label: '刷新邮件', aliases: 'refresh 同步' },
      { keys: '⌘T', label: '切换明暗', aliases: 'theme 主题 深色 浅色' },
      { keys: '⌘,', label: '打开设置', aliases: 'settings 偏好' },
      { keys: '⌘⇧G', label: '加密沟通（幽灵信）', aliases: 'ghost 加密 私密' }
    ]
  },
  {
    title: '导航',
    items: [
      { keys: '⌘0', label: '全部账户', aliases: 'unified 账户' },
      { keys: '⌘1–9', label: '切换第 N 个账户', aliases: 'account 账户' },
      { keys: '⌘J', label: '右侧栏切到 Agent', aliases: 'agent 右侧栏' },
      { keys: 'J / K', label: '下一封 / 上一封', aliases: 'next previous 邮件' },
      { keys: 'Esc', label: '退出逐封处理 / 关闭浮层', aliases: 'back 返回' }
    ]
  },
  {
    title: '邮件',
    items: [
      { keys: 'E / A', label: '归档', aliases: 'archive 归档' },
      { keys: 'S', label: '稍后处理', aliases: 'snooze 稍后' },
      { keys: 'R', label: '回复', aliases: 'reply 回复' },
      { keys: 'V', label: '移动到文件夹（AI 先猜目标）', aliases: 'move 移动 文件夹' },
      { keys: 'T', label: '转成待办', aliases: 'todo 待办' },
      { keys: '⌫', label: '删除', aliases: 'delete 删除' }
    ]
  },
  {
    title: '加密沟通',
    items: [
      { keys: '⌘⇧G', label: '打开加密沟通', aliases: 'ghost 幽灵信' },
      { keys: '⌘↵', label: '投递幽灵信', aliases: 'send 发送 投递' },
      { keys: 'Esc', label: '关闭当前窗口', aliases: 'close 关闭' }
    ]
  }
]
