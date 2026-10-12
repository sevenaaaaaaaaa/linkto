import { useWindowDimensions } from 'react-native'

/**
 * 平板判定：短边 ≥ 600（iPad 最小 768、安卓/鸿蒙平板主流 600+；
 * 手机横屏短边仍 < 600，不会误入双栏布局）
 */
export function useTablet(): boolean {
  const { width, height } = useWindowDimensions()
  return Math.min(width, height) >= 600
}

/** 平板左栏固定宽度 */
export const LIST_PANE_WIDTH = 380