import { View, type ColorValue, type ViewStyle } from 'react-native'
import { T } from '../theme'

/** Small platform-independent vector icons; no emoji fonts or bitmap assets. */
export function Icon({ name, color = T.inkSoft, size = 22 }: { name: 'mail' | 'today' | 'note' | 'more' | 'plus' | 'check'; color?: ColorValue; size?: number }) {
  const line = (style: ViewStyle, key: string) => <View key={key} style={[{ position: 'absolute', backgroundColor: color, borderRadius: 2 }, style]} />
  const box = (style: ViewStyle, key: string) => <View key={key} style={[{ position: 'absolute', borderWidth: 1.7, borderColor: color, borderRadius: 3 }, style]} />
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
    <View style={{ width: 24, height: 24, transform: [{ scale: size / 24 }], transformOrigin: 'top left' }}>
      {name === 'mail' && <>{box({ left: 2, top: 5, width: 20, height: 15 }, 'box')}{line({ left: 3, top: 9, width: 10, height: 1.7, transform: [{ rotate: '32deg' }] }, 'l')}{line({ left: 11, top: 9, width: 10, height: 1.7, transform: [{ rotate: '-32deg' }] }, 'r')}</>}
      {name === 'today' && <>{box({ left: 3, top: 4, width: 18, height: 18 }, 'box')}{line({ left: 3, top: 9, width: 18, height: 1.7 }, 'divider')}{[7, 16].map(x => line({ left: x, top: 1, width: 1.7, height: 6 }, `r${x}`))}{[7, 13].map(x => line({ left: x, top: 13, width: 3, height: 3 }, `d${x}`))}</>}
      {name === 'note' && <>{box({ left: 4, top: 2, width: 16, height: 20 }, 'box')}{[7, 12, 17].map(y => line({ left: 8, top: y, width: y === 17 ? 5 : 9, height: 1.7 }, String(y)))}</>}
      {name === 'more' && [3, 10, 17].map(x => line({ left: x, top: 10, width: 4, height: 4, borderRadius: 2 }, String(x)))}
      {name === 'plus' && <>{line({ left: 4, top: 11, width: 16, height: 2 }, 'h')}{line({ left: 11, top: 4, width: 2, height: 16 }, 'v')}</>}
      {name === 'check' && <>{line({ left: 3, top: 13, width: 8, height: 2, transform: [{ rotate: '45deg' }] }, 'l')}{line({ left: 8, top: 10, width: 14, height: 2, transform: [{ rotate: '-45deg' }] }, 'r')}</>}
    </View>
  </View>
}
