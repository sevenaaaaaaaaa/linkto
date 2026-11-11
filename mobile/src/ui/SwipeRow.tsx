import { Pressable } from 'react-native'
import { ActionRow } from './ActionRow'
export function SwipeRow({ seen, disabled = false, onPress, onLongPress, onToggle, onArchive, onTrash, children }: {
  seen: boolean; disabled?: boolean; onPress(): void; onLongPress(): void; onToggle(): void; onArchive?(): void; onTrash?(): void; children: React.ReactNode
}) {
  return <ActionRow disabled={disabled} fullSwipeTrailing={!!onTrash} leading={onArchive ? { label: '归档', run: onArchive } : undefined} trailing={[{ label: seen ? '标为未读' : '标为已读', run: onToggle }, ...(onTrash ? [{ label: '垃圾箱', danger: true, run: onTrash }] : [])]}>
    <Pressable accessible={false} onPress={onPress} onLongPress={onLongPress} delayLongPress={400}>{children}</Pressable>
  </ActionRow>
}
