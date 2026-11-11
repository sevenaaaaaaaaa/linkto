/** Require a deliberate long gesture, even when an action tray is already open. */
export const fullSwipeThreshold = (width: number) => Math.max(180, Math.min(240, width * 0.65))
export const isFullDeleteSwipe = (distance: number, width: number, base = 0) => distance <= -fullSwipeThreshold(width) && distance + base <= -fullSwipeThreshold(width)
