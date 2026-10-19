import type { SVGProps } from 'react'
import type { TraceChannel } from '@shared/trace'

/** 留痕图标（与 icons.tsx 同规格：24×24 描边 1.8） */
type P = SVGProps<SVGSVGElement>
const S = (p: P & { children: React.ReactNode }) => {
  const { children, ...rest } = p
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  )
}

/** 侧栏入口：一页纸 + 落款印 */
export const IconTrace = (p: P) => (
  <S {...p}>
    <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h4" />
    <path d="M14 3.5V8h4.5M14 3.5 18.5 8v3" />
    <path d="M8.5 11.5h5M8.5 15h2.5" />
    <circle cx="17" cy="17" r="3.5" />
    <path d="M15.6 17l1 1 1.8-1.9" />
  </S>
)

export const IconPhone = (p: P) => (
  <S {...p}>
    <path d="M6.5 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 6.7 6.7l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z" />
  </S>
)

const Bubble = (p: P) => (
  <S {...p}>
    <path d="M4 11.5a7.5 6.5 0 1 1 3.4 5.4L4 18l1-3.2a6 6 0 0 1-1-3.3z" />
    <path d="M9 11h.01M12.5 11h.01M16 11h.01" strokeWidth={2.4} />
  </S>
)

const Meeting = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="4" width="17" height="11" rx="2" />
    <path d="M8 20l4-5 4 5" />
  </S>
)

const InPerson = (p: P) => (
  <S {...p}>
    <circle cx="8" cy="7.5" r="2.5" />
    <circle cx="16" cy="7.5" r="2.5" />
    <path d="M3.5 19c.6-3 2.4-4.8 4.5-4.8s3.9 1.8 4.5 4.8M11.5 19c.6-3 2.4-4.8 4.5-4.8s3.9 1.8 4.5 4.8" />
  </S>
)

const Im = (p: P) => (
  <S {...p}>
    <path d="M4 6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3.3A2 2 0 0 1 4 12z" />
    <path d="M17 9h1a2 2 0 0 1 2 2v5a2 2 0 0 1-1 1.7V20l-3-2h-4a2 2 0 0 1-1.6-.8" />
  </S>
)

export const IconNote = (p: P) => (
  <S {...p}>
    <path d="M5 4.5h10l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z" />
    <path d="M8 11h8M8 14.5h8M8 18h5" />
  </S>
)

export const IconImage = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 16l-4.5-4.5L6 19.5" />
  </S>
)

export const IconSeal = (p: P) => (
  <S {...p}>
    <path d="M12 3l2.1 1.5 2.6-.2.8 2.5 2.1 1.5-.9 2.4.9 2.4-2.1 1.5-.8 2.5-2.6-.2L12 18l-2.1-1.5-2.6.2-.8-2.5-2.1-1.5.9-2.4-.9-2.4 2.1-1.5.8-2.5 2.6.2z" />
    <path d="M9.3 10.6l1.8 1.8 3.6-3.6" />
  </S>
)

export function ChannelIcon(props: P & { channel: TraceChannel }) {
  const { channel, ...rest } = props
  switch (channel) {
    case 'phone':
      return <IconPhone {...rest} />
    case 'wechat':
      return <Bubble {...rest} />
    case 'meeting':
      return <Meeting {...rest} />
    case 'in-person':
      return <InPerson {...rest} />
    case 'im':
      return <Im {...rest} />
    default:
      return <IconNote {...rest} />
  }
}
