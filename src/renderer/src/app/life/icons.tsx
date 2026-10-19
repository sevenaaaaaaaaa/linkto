import type { SVGProps } from 'react'
import type { LifeCategory } from '@shared/types'

/** 生活档案图标（与 icons.tsx 同规格：24×24 描边 1.8） */
type P = SVGProps<SVGSVGElement>
const S = (p: P & { children: React.ReactNode }) => {
  const { children, ...rest } = p
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  )
}

/** 侧栏入口：日历 + 勾 */
export const IconLife = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
    <path d="M9 15l2 2 4-4" />
  </S>
)

const IdCard = (p: P) => (
  <S {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="9" cy="11" r="2" />
    <path d="M6 16c.6-1.3 1.7-2 3-2s2.4.7 3 2M14 10h4M14 13.5h3" />
  </S>
)
const Shield = (p: P) => (
  <S {...p}>
    <path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6L12 3z" />
    <path d="M9 12l2 2 4-4" />
  </S>
)
const Car = (p: P) => (
  <S {...p}>
    <path d="M5 16V12l2-5h10l2 5v4" />
    <path d="M3.5 16h17v2.5h-17zM5 12h14" />
    <circle cx="7.5" cy="14" r="0.6" fill="currentColor" />
    <circle cx="16.5" cy="14" r="0.6" fill="currentColor" />
  </S>
)
const Badge = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="9" r="5.5" />
    <path d="M8.5 13.5L7 21l5-2.5 5 2.5-1.5-7.5" />
    <path d="M12 6.5l.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z" />
  </S>
)
const Globe = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z" />
  </S>
)
const Wrench = (p: P) => (
  <S {...p}>
    <path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 0-2-2z" />
    <path d="M14.5 6.5l3-3a4 4 0 0 0-3 3z" />
  </S>
)
const Pen = (p: P) => (
  <S {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
    <path d="M14 3v5h5M8.5 17c1.2-1.8 2.2-1.8 3 0s1.8 1.8 3.5-.5" />
  </S>
)
const Home = (p: P) => (
  <S {...p}>
    <path d="M3.5 11L12 4l8.5 7" />
    <path d="M5.5 9.5V20h13V9.5M10 20v-5h4v5" />
  </S>
)
const Percent = (p: P) => (
  <S {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M9 15l6-6" />
    <circle cx="9.5" cy="9.5" r="1" />
    <circle cx="14.5" cy="14.5" r="1" />
  </S>
)
const Pulse = (p: P) => (
  <S {...p}>
    <path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z" />
    <path d="M7 12h2.5l1.2-2 2 4 1.3-2H17" />
  </S>
)
const Cap = (p: P) => (
  <S {...p}>
    <path d="M2.5 9.5L12 5l9.5 4.5L12 14 2.5 9.5z" />
    <path d="M6.5 11.5V16c1.5 1.4 3.4 2 5.5 2s4-.6 5.5-2v-4.5M21.5 9.5V15" />
  </S>
)
const Card = (p: P) => (
  <S {...p}>
    <rect x="3" y="5.5" width="18" height="13" rx="2" />
    <path d="M3 10h18M7 15h3" />
  </S>
)
const Dot = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l2.5 2.5" />
  </S>
)

const MAP: Record<LifeCategory, (p: P) => React.ReactElement> = {
  'id-document': IdCard,
  insurance: Shield,
  vehicle: Car,
  membership: Badge,
  domain: Globe,
  warranty: Wrench,
  contract: Pen,
  housing: Home,
  tax: Percent,
  health: Pulse,
  education: Cap,
  card: Card,
  other: Dot
}

export function CategoryIcon(props: P & { category: LifeCategory }) {
  const { category, ...rest } = props
  const I = MAP[category] ?? Dot
  return <I {...rest} />
}
