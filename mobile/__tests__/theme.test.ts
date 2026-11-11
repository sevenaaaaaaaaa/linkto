import { Appearance, Platform, StyleSheet } from 'react-native'
import { T, themedStyles } from '../src/theme'
test('Android styles change with system appearance without replacing editor components', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  const scheme = jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('light')
  try {
    const styles = themedStyles(() => StyleSheet.create({ card: { backgroundColor: T.paper, color: T.ink } }))
    expect(styles.card.backgroundColor).toBe('#F4F5F7')
    scheme.mockReturnValue('dark')
    expect(styles.card.backgroundColor).toBe('#0E1116')
    expect(styles.card.color).toBe('#F0F1F4')
    scheme.mockReturnValue('light')
    expect(styles.card.backgroundColor).toBe('#F4F5F7')
  } finally { scheme.mockRestore(); Object.defineProperty(Platform, 'OS', descriptor) }
})
