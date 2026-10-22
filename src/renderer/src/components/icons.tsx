import type { ReactElement, SVGProps } from 'react'
import * as base from './icons-base'
import { SfSymbol } from './SfSymbol'
import { SF_SYMBOL_BY_ICON } from '@shared/sf-symbols'

/**
 * 图标入口：macOS 上优先用系统 SF Symbols（运行时由 AppKit 渲染成 mask PNG），
 * 其它平台 / 旧系统 / 缺失 symbol 自动回退到 icons-base 的手写 SVG。
 * 组件名保持与旧文件完全一致，业务代码不需要改 import。
 */
type P = SVGProps<SVGSVGElement>

function sf(name: string, Fallback: (p: P) => ReactElement) {
  function SfIcon(p: P) {
    return <SfSymbol name={name} {...p} fallback={<Fallback {...p} />} />
  }
  return SfIcon
}

export * from './icons-base'

export const IconInbox = sf(SF_SYMBOL_BY_ICON.inbox, base.IconInbox)
export const IconLayers = sf(SF_SYMBOL_BY_ICON.layers, base.IconLayers)
export const IconStar = sf(SF_SYMBOL_BY_ICON.star, base.IconStar)
export const IconUser = sf(SF_SYMBOL_BY_ICON.user, base.IconUser)
export const IconBell = sf(SF_SYMBOL_BY_ICON.bell, base.IconBell)
export const IconRss = sf(SF_SYMBOL_BY_ICON.rss, base.IconRss)
export const IconTrash = sf(SF_SYMBOL_BY_ICON.trash, base.IconTrash)
export const IconArchive = sf(SF_SYMBOL_BY_ICON.archive, base.IconArchive)
export const IconBook = sf(SF_SYMBOL_BY_ICON.book, base.IconBook)
export const IconFolder = sf(SF_SYMBOL_BY_ICON.folder, base.IconFolder)
export const IconCompose = sf(SF_SYMBOL_BY_ICON.compose, base.IconCompose)
export const IconReply = sf(SF_SYMBOL_BY_ICON.reply, base.IconReply)
export const IconReplyAll = sf(SF_SYMBOL_BY_ICON.replyAll, base.IconReplyAll)
export const IconForward = sf(SF_SYMBOL_BY_ICON.forward, base.IconForward)
export const IconFlag = sf(SF_SYMBOL_BY_ICON.flag, base.IconFlag)
export const IconSearch = sf(SF_SYMBOL_BY_ICON.search, base.IconSearch)
export const IconSparkles = sf(SF_SYMBOL_BY_ICON.sparkles, base.IconSparkles)
export const IconAttach = sf(SF_SYMBOL_BY_ICON.attach, base.IconAttach)
export const IconSettings = sf(SF_SYMBOL_BY_ICON.settings, base.IconSettings)
export const IconChevronDown = sf(SF_SYMBOL_BY_ICON.chevronDown, base.IconChevronDown)
export const IconChevronRight = sf(SF_SYMBOL_BY_ICON.chevronRight, base.IconChevronRight)
export const IconMore = sf(SF_SYMBOL_BY_ICON.more, base.IconMore)
export const IconMailDot = sf(SF_SYMBOL_BY_ICON.mailDot, base.IconMailDot)
export const IconFilter = sf(SF_SYMBOL_BY_ICON.filter, base.IconFilter)
export const IconUnsub = sf(SF_SYMBOL_BY_ICON.unsub, base.IconUnsub)
export const IconSave = sf(SF_SYMBOL_BY_ICON.save, base.IconSave)
export const IconRefresh = sf(SF_SYMBOL_BY_ICON.refresh, base.IconRefresh)
export const IconPlug = sf(SF_SYMBOL_BY_ICON.plug, base.IconPlug)
export const IconSend = sf(SF_SYMBOL_BY_ICON.send, base.IconSend)
export const IconPlus = sf(SF_SYMBOL_BY_ICON.plus, base.IconPlus)
export const IconMinus = sf(SF_SYMBOL_BY_ICON.minus, base.IconMinus)
export const IconClose = sf(SF_SYMBOL_BY_ICON.close, base.IconClose)
export const IconCheck = sf(SF_SYMBOL_BY_ICON.check, base.IconCheck)
export const IconTask = sf(SF_SYMBOL_BY_ICON.task, base.IconTask)
export const IconPin = sf(SF_SYMBOL_BY_ICON.pin, base.IconPin)
export const IconRobot = sf(SF_SYMBOL_BY_ICON.robot, base.IconRobot)
export const IconClock = sf(SF_SYMBOL_BY_ICON.clock, base.IconClock)
export const IconCloud = sf(SF_SYMBOL_BY_ICON.cloud, base.IconCloud)
export const IconPalette = sf(SF_SYMBOL_BY_ICON.palette, base.IconPalette)
export const IconSun = sf(SF_SYMBOL_BY_ICON.sun, base.IconSun)
export const IconMoon = sf(SF_SYMBOL_BY_ICON.moon, base.IconMoon)
export const IconSunMoon = sf(SF_SYMBOL_BY_ICON.sunMoon, base.IconSunMoon)
export const IconKey = sf(SF_SYMBOL_BY_ICON.key, base.IconKey)
export const IconLock = sf(SF_SYMBOL_BY_ICON.lock, base.IconLock)
export const IconGhost = sf(SF_SYMBOL_BY_ICON.ghost, base.IconGhost)
export const IconChat = sf(SF_SYMBOL_BY_ICON.chat, base.IconChat)
export const IconCheckSquare = sf(SF_SYMBOL_BY_ICON.checkSquare, base.IconCheckSquare)
export const IconBrain = sf(SF_SYMBOL_BY_ICON.brain, base.IconBrain)
export const IconLink = sf(SF_SYMBOL_BY_ICON.link, base.IconLink)
export const IconFileText = sf(SF_SYMBOL_BY_ICON.fileText, base.IconFileText)
export const IconBuilding = sf(SF_SYMBOL_BY_ICON.building, base.IconBuilding)
export const IconSunrise = sf(SF_SYMBOL_BY_ICON.sunrise, base.IconSunrise)
export const IconShield = sf(SF_SYMBOL_BY_ICON.shield, base.IconShield)
export const IconTarget = sf(SF_SYMBOL_BY_ICON.target, base.IconTarget)
export const IconTrendingUp = sf(SF_SYMBOL_BY_ICON.trendingUp, base.IconTrendingUp)
export const IconHeart = sf(SF_SYMBOL_BY_ICON.heart, base.IconHeart)
export const IconUsers = sf(SF_SYMBOL_BY_ICON.users, base.IconUsers)
export const IconBellRing = sf(SF_SYMBOL_BY_ICON.bellRing, base.IconBellRing)
export const IconQuote = sf(SF_SYMBOL_BY_ICON.quote, base.IconQuote)
export const IconList = sf(SF_SYMBOL_BY_ICON.list, base.IconList)
export const IconListOrdered = sf(SF_SYMBOL_BY_ICON.listOrdered, base.IconListOrdered)
export const IconHourglass = sf(SF_SYMBOL_BY_ICON.hourglass, base.IconHourglass)
export const IconCalendar = sf(SF_SYMBOL_BY_ICON.calendar, base.IconCalendar)
export const IconReceipt = sf(SF_SYMBOL_BY_ICON.receipt, base.IconReceipt)
export const IconBriefcase = sf(SF_SYMBOL_BY_ICON.briefcase, base.IconBriefcase)
export const IconLandmark = sf(SF_SYMBOL_BY_ICON.landmark, base.IconLandmark)
export const IconPlane = sf(SF_SYMBOL_BY_ICON.plane, base.IconPlane)
export const IconPackage = sf(SF_SYMBOL_BY_ICON.package, base.IconPackage)
export const IconGrid = sf(SF_SYMBOL_BY_ICON.grid, base.IconGrid)
export const IconPlay = sf(SF_SYMBOL_BY_ICON.play, base.IconPlay)
export const IconZap = sf(SF_SYMBOL_BY_ICON.zap, base.IconZap)
