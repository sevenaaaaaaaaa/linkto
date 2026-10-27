import Clipboard from '@react-native-clipboard/clipboard'

/** 复制并在 45 秒后清空（若剪贴板仍是这段内容） */
export function copyWithClear(text: string, ms = 45_000): void {
  Clipboard.setString(text)
  setTimeout(async () => {
    try {
      const now = await Clipboard.getString()
      if (now === text) Clipboard.setString('')
    } catch {
      /* ignore */
    }
  }, ms)
}
