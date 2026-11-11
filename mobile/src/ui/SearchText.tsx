import { Text, type TextProps } from 'react-native'
import { T } from '../theme'
export function SearchText({ children, query, ...props }: TextProps & { children: string; query: string }) {
  const index = query ? children.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1
  return <Text {...props}>{index < 0 ? children : <>{children.slice(0, index)}<Text style={{ backgroundColor: T.accentSoft, color: T.accentDeep, fontWeight: '700' }}>{children.slice(index, index + query.length)}</Text>{children.slice(index + query.length)}</>}</Text>
}
