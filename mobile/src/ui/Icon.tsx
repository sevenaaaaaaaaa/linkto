import { View, type ColorValue } from 'react-native'
import Svg, { Path, Rect, Circle, Polyline } from 'react-native-svg'
import { T } from '../theme'
export type IconName = 'mail' | 'today' | 'note' | 'agent' | 'more' | 'plus' | 'check' | 'search' | 'folder' | 'restore' | 'chevron' | 'settings' | 'sparkles' | 'arrow' | 'shield' | 'close'
/** Shares desktop icons-base.tsx geometry and 1.8pt stroke. */
export function Icon({ name, color = T.inkSoft, size = 22 }: { name: IconName; color?: ColorValue; size?: number }) {
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}><Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {name === 'mail' && <><Path d="M22 12h-6l-2 3h-4l-2-3H2" /><Path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>}
    {name === 'today' && <><Polyline points="9 11 12 14 22 4" /><Path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>}
    {name === 'note' && <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />}
    {name === 'agent' && <><Rect x={4} y={9} width={16} height={11} rx={2.5} /><Path d="M12 9V5M9.5 17.5h5" /><Circle cx={12} cy={3.5} r={1.2} /><Circle cx={9} cy={14} r={0.9} fill={color} stroke="none" /><Circle cx={15} cy={14} r={0.9} fill={color} stroke="none" /></>}
    {name === 'more' && [5, 12, 19].map(x => <Circle key={x} cx={x} cy={12} r={1} fill={color} />)}
    {name === 'plus' && <Path d="M12 5v14M5 12h14" />}
    {name === 'check' && <Polyline points="20 6 9 17 4 12" />}
    {name === 'search' && <><Circle cx={11} cy={11} r={7} /><Path d="m16 16 5 5" /></>}
    {name === 'folder' && <Path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />}
    {name === 'restore' && <Path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2" />}
    {name === 'chevron' && <Path d="m9 5 7 7-7 7" />}
    {name === 'arrow' && <Path d="M4 12h16m-6-6 6 6-6 6" />}
    {name === 'shield' && <><Path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z" /><Path d="m8 12 3 3 5-6" /></>}
    {name === 'sparkles' && <Path d="m12 3 1.9 5.7a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-2a2 2 0 0 0 1.3-1.3L12 3z" />}
    {name === 'settings' && <><Circle cx={12} cy={12} r={3} /><Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>}
    {name === 'close' && <Path d="m6 6 12 12M18 6 6 18" />}
  </Svg></View>
}
