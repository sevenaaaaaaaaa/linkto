import { fullSwipeThreshold, isFullDeleteSwipe } from '../src/ui/swipe-policy'
test('short gestures expose actions and long left gestures deliberately commit quick delete', () => {
  expect(isFullDeleteSwipe(-100, 340)).toBe(false)
  expect(isFullDeleteSwipe(-230, 340)).toBe(true)
  expect(isFullDeleteSwipe(-80, 340, -160)).toBe(false)
  expect(isFullDeleteSwipe(-230, 340, 80)).toBe(false)
  expect(isFullDeleteSwipe(-320, 340, 80)).toBe(true)
  expect(isFullDeleteSwipe(300, 340)).toBe(false)
  expect(fullSwipeThreshold(220)).toBe(180)
  expect(fullSwipeThreshold(1000)).toBe(240)
})
