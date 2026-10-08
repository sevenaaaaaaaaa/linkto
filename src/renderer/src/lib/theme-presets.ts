/**
 * 主题预设 —— 移植自 ThirdC presets.json（源头：OpenFlow Dev/lib/ThemeSystem.php presets()）
 * 每个预设含完整的明暗两套 token + 布局参数；应用方式见 lib/theme.ts（注入 theme-override 覆盖层）
 */

export interface PresetPalette {
  bg: string
  'bg-soft': string
  surface: string
  'surface-strong': string
  fg: string
  muted: string
  faint: string
  border: string
  'border-strong': string
  hover: string
  'hover-strong': string
  accent: string
  'accent-strong': string
  'accent-soft': string
  'on-accent': string
  glass: string
  'glass-bright': string
  'glass-border': string
  'blob-a': string
  'blob-b': string
  'blob-c': string
  shadow: string
  'shadow-sm': string
}

export interface PresetLayout {
  'r-lg'?: string
  'r-md'?: string
  'r-sm'?: string
  'font-display'?: string
  'font-body'?: string
}

export interface ThemePreset {
  id: string
  name: string
  desc: string
  light: PresetPalette
  dark: PresetPalette
  layout: PresetLayout
}

/** 预设 token → 本项目 CSS 变量名的映射（theme-override 注入用） */
export const PRESET_VAR_MAP: Record<string, string> = {
  bg: '--bg',
  'bg-soft': '--bg-soft',
  surface: '--surface',
  'surface-strong': '--surface-strong',
  fg: '--fg',
  muted: '--muted',
  faint: '--faint',
  border: '--border',
  'border-strong': '--border-strong',
  hover: '--hover',
  'hover-strong': '--hover-strong',
  accent: '--accent',
  'accent-strong': '--accent-strong',
  'accent-soft': '--accent-soft',
  'on-accent': '--on-accent',
  glass: '--glass',
  'glass-bright': '--glass-bright',
  'glass-border': '--glass-border',
  'blob-a': '--blob-a',
  'blob-b': '--blob-b',
  'blob-c': '--blob-c',
  shadow: '--shadow',
  'shadow-sm': '--shadow-sm'
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: 'OpenFlow 官方',
    desc: '奶油底 + 蓝紫 accent + 玻璃拟态',
    light: {
      bg: 'oklch(96.5% .016 85)', 'bg-soft': 'oklch(94% .02 85)', surface: 'oklch(100% 0 0/.62)', 'surface-strong': 'oklch(100% 0 0/.88)',
      fg: 'oklch(22% .02 70)', muted: 'oklch(46% .016 70)', faint: 'oklch(60% .012 75)', border: 'oklch(86% .014 80)', 'border-strong': 'oklch(76% .02 80)',
      hover: 'oklch(22% .02 70/.055)', 'hover-strong': 'oklch(22% .02 70/.11)', accent: 'oklch(52% .17 258)', 'accent-strong': 'oklch(46% .17 258)',
      'accent-soft': 'oklch(52% .17 258/.12)', 'on-accent': 'oklch(100% 0 0)', glass: 'oklch(100% 0 0/.5)', 'glass-bright': 'oklch(100% 0 0/.66)',
      'glass-border': 'oklch(100% 0 0/.68)', 'blob-a': 'oklch(72% .12 262/.30)', 'blob-b': 'oklch(70% .13 305/.24)', 'blob-c': 'oklch(74% .11 200/.22)',
      shadow: '0 24px 60px -24px oklch(30% .04 80/.28)', 'shadow-sm': '0 10px 28px -14px oklch(30% .04 80/.22)'
    },
    dark: {
      bg: 'oklch(19% .014 70)', 'bg-soft': 'oklch(22.5% .014 72)', surface: 'oklch(27% .016 75/.55)', 'surface-strong': 'oklch(30% .016 75/.82)',
      fg: 'oklch(93% .008 85)', muted: 'oklch(70% .014 80)', faint: 'oklch(55% .012 80)', border: 'oklch(100% 0 0/.1)', 'border-strong': 'oklch(100% 0 0/.2)',
      hover: 'oklch(93% .008 85/.07)', 'hover-strong': 'oklch(93% .008 85/.13)', accent: 'oklch(74% .13 258)', 'accent-strong': 'oklch(80% .12 258)',
      'accent-soft': 'oklch(74% .13 258/.15)', 'on-accent': 'oklch(16% .03 260)', glass: 'oklch(30% .014 75/.5)', 'glass-bright': 'oklch(34% .014 75/.62)',
      'glass-border': 'oklch(100% 0 0/.15)', 'blob-a': 'oklch(62% .13 262/.18)', 'blob-b': 'oklch(58% .14 305/.15)', 'blob-c': 'oklch(60% .12 200/.13)',
      shadow: '0 24px 60px -24px oklch(0% 0 0/.55)', 'shadow-sm': '0 10px 28px -14px oklch(0% 0 0/.5)'
    },
    layout: { 'r-lg': '26px', 'r-md': '18px', 'r-sm': '12px' }
  },
  {
    id: 'notion',
    name: 'Notion Like',
    desc: '纯白极简 · 中性灰 · 直角 · 密集排版',
    light: {
      bg: 'oklch(100% 0 0)', 'bg-soft': 'oklch(97% 0 0)', surface: 'oklch(100% 0 0/1)', 'surface-strong': 'oklch(100% 0 0/1)',
      fg: 'oklch(24% 0 0)', muted: 'oklch(45% 0 0)', faint: 'oklch(60% 0 0)', border: 'oklch(88% 0 0)', 'border-strong': 'oklch(78% 0 0)',
      hover: 'oklch(96% 0 0)', 'hover-strong': 'oklch(92% 0 0)', accent: 'oklch(30% 0 0)', 'accent-strong': 'oklch(20% 0 0)',
      'accent-soft': 'oklch(30% 0 0/.08)', 'on-accent': 'oklch(100% 0 0)', glass: 'oklch(100% 0 0/1)', 'glass-bright': 'oklch(100% 0 0/1)',
      'glass-border': 'oklch(88% 0 0)', 'blob-a': 'oklch(95% 0 0/.5)', 'blob-b': 'oklch(95% 0 0/.4)', 'blob-c': 'oklch(95% 0 0/.4)',
      shadow: '0 1px 2px oklch(0% 0 0/.04)', 'shadow-sm': '0 1px 1px oklch(0% 0 0/.03)'
    },
    dark: {
      bg: 'oklch(20% 0 0)', 'bg-soft': 'oklch(24% 0 0)', surface: 'oklch(24% 0 0/1)', 'surface-strong': 'oklch(28% 0 0/1)',
      fg: 'oklch(92% 0 0)', muted: 'oklch(70% 0 0)', faint: 'oklch(55% 0 0)', border: 'oklch(100% 0 0/.08)', 'border-strong': 'oklch(100% 0 0/.16)',
      hover: 'oklch(100% 0 0/.04)', 'hover-strong': 'oklch(100% 0 0/.08)', accent: 'oklch(85% 0 0)', 'accent-strong': 'oklch(95% 0 0)',
      'accent-soft': 'oklch(85% 0 0/.1)', 'on-accent': 'oklch(15% 0 0)', glass: 'oklch(24% 0 0/1)', 'glass-bright': 'oklch(28% 0 0/1)',
      'glass-border': 'oklch(100% 0 0/.08)', 'blob-a': 'oklch(22% 0 0/.4)', 'blob-b': 'oklch(22% 0 0/.3)', 'blob-c': 'oklch(22% 0 0/.3)',
      shadow: '0 1px 2px oklch(0% 0 0/.3)', 'shadow-sm': '0 1px 1px oklch(0% 0 0/.25)'
    },
    layout: { 'r-lg': '4px', 'r-md': '3px', 'r-sm': '2px', 'font-body': 'system-ui,-apple-system,"PingFang SC",sans-serif' }
  },
  {
    id: 'claude',
    name: 'Claude Like',
    desc: '暖纸底 + 珊瑚 accent + 等宽字体 + 直角',
    light: {
      bg: 'oklch(97% .005 40)', 'bg-soft': 'oklch(94% .006 40)', surface: 'oklch(100% 0 0/1)', 'surface-strong': 'oklch(100% 0 0/1)',
      fg: 'oklch(24% .008 40)', muted: 'oklch(46% .01 40)', faint: 'oklch(60% .01 40)', border: 'oklch(88% .006 40)', 'border-strong': 'oklch(78% .008 40)',
      hover: 'oklch(95% .005 40)', 'hover-strong': 'oklch(91% .006 40)', accent: 'oklch(62% .13 45)', 'accent-strong': 'oklch(55% .14 45)',
      'accent-soft': 'oklch(62% .13 45/.12)', 'on-accent': 'oklch(100% 0 0)', glass: 'oklch(100% 0 0/1)', 'glass-bright': 'oklch(100% 0 0/1)',
      'glass-border': 'oklch(88% .006 40)', 'blob-a': 'oklch(75% .05 45/.25)', 'blob-b': 'oklch(72% .06 20/.2)', 'blob-c': 'oklch(73% .04 60/.2)',
      shadow: '0 2px 8px oklch(30% .02 40/.1)', 'shadow-sm': '0 1px 4px oklch(30% .02 40/.08)'
    },
    dark: {
      bg: 'oklch(20% .006 40)', 'bg-soft': 'oklch(23% .006 40)', surface: 'oklch(24% .007 40/1)', 'surface-strong': 'oklch(28% .008 40/1)',
      fg: 'oklch(92% .006 40)', muted: 'oklch(70% .008 40)', faint: 'oklch(55% .01 40)', border: 'oklch(100% 0 0/.09)', 'border-strong': 'oklch(100% 0 0/.18)',
      hover: 'oklch(100% 0 0/.05)', 'hover-strong': 'oklch(100% 0 0/.09)', accent: 'oklch(68% .13 45)', 'accent-strong': 'oklch(73% .12 45)',
      'accent-soft': 'oklch(68% .13 45/.16)', 'on-accent': 'oklch(15% .02 40)', glass: 'oklch(24% .007 40/1)', 'glass-bright': 'oklch(28% .008 40/1)',
      'glass-border': 'oklch(100% 0 0/.09)', 'blob-a': 'oklch(55% .06 45/.16)', 'blob-b': 'oklch(52% .07 20/.14)', 'blob-c': 'oklch(53% .05 60/.14)',
      shadow: '0 4px 16px oklch(0% 0 0/.4)', 'shadow-sm': '0 2px 8px oklch(0% 0 0/.3)'
    },
    layout: { 'r-lg': '4px', 'r-md': '3px', 'r-sm': '2px', 'font-body': '"SF Mono","JetBrains Mono",ui-monospace,Menlo,monospace' }
  },
  {
    id: 'apple',
    name: 'Apple Like',
    desc: '浅灰白 + 蓝 accent + 强毛玻璃 + 大圆角',
    light: {
      bg: 'oklch(98% .004 250)', 'bg-soft': 'oklch(95% .006 250)', surface: 'oklch(100% 0 0/.72)', 'surface-strong': 'oklch(100% 0 0/.92)',
      fg: 'oklch(20% .01 255)', muted: 'oklch(45% .01 255)', faint: 'oklch(58% .008 255)', border: 'oklch(88% .005 250)', 'border-strong': 'oklch(78% .008 250)',
      hover: 'oklch(20% .01 255/.05)', 'hover-strong': 'oklch(20% .01 255/.1)', accent: 'oklch(55% .18 255)', 'accent-strong': 'oklch(50% .18 255)',
      'accent-soft': 'oklch(55% .18 255/.12)', 'on-accent': 'oklch(100% 0 0)', glass: 'oklch(100% 0 0/.55)', 'glass-bright': 'oklch(100% 0 0/.75)',
      'glass-border': 'oklch(100% 0 0/.8)', 'blob-a': 'oklch(80% .1 255/.25)', 'blob-b': 'oklch(78% .1 305/.2)', 'blob-c': 'oklch(82% .08 200/.2)',
      shadow: '0 20px 50px -20px oklch(25% .02 255/.25)', 'shadow-sm': '0 8px 24px -10px oklch(25% .02 255/.2)'
    },
    dark: {
      bg: 'oklch(16% .01 255)', 'bg-soft': 'oklch(20% .012 255)', surface: 'oklch(24% .012 255/.6)', 'surface-strong': 'oklch(28% .012 255/.85)',
      fg: 'oklch(95% .004 250)', muted: 'oklch(72% .008 255)', faint: 'oklch(58% .01 255)', border: 'oklch(100% 0 0/.1)', 'border-strong': 'oklch(100% 0 0/.2)',
      hover: 'oklch(95% .004 250/.07)', 'hover-strong': 'oklch(95% .004 250/.13)', accent: 'oklch(68% .16 255)', 'accent-strong': 'oklch(75% .15 255)',
      'accent-soft': 'oklch(68% .16 255/.16)', 'on-accent': 'oklch(14% .01 255)', glass: 'oklch(24% .012 255/.55)', 'glass-bright': 'oklch(28% .012 255/.7)',
      'glass-border': 'oklch(100% 0 0/.14)', 'blob-a': 'oklch(58% .12 255/.15)', 'blob-b': 'oklch(55% .12 305/.13)', 'blob-c': 'oklch(58% .1 200/.13)',
      shadow: '0 24px 50px -24px oklch(0% 0 0/.5)', 'shadow-sm': '0 10px 24px -12px oklch(0% 0 0/.42)'
    },
    layout: { 'r-lg': '22px', 'r-md': '16px', 'r-sm': '10px' }
  },
  {
    id: 'linear',
    name: 'Linear Like',
    desc: '近黑深色 + 紫蓝 accent + 细边框 + 紧凑',
    light: {
      bg: 'oklch(97% .003 280)', 'bg-soft': 'oklch(94% .004 280)', surface: 'oklch(100% 0 0/1)', 'surface-strong': 'oklch(100% 0 0/1)',
      fg: 'oklch(22% .01 280)', muted: 'oklch(45% .012 280)', faint: 'oklch(58% .01 280)', border: 'oklch(88% .005 280)', 'border-strong': 'oklch(78% .008 280)',
      hover: 'oklch(22% .01 280/.04)', 'hover-strong': 'oklch(22% .01 280/.08)', accent: 'oklch(56% .18 285)', 'accent-strong': 'oklch(50% .18 285)',
      'accent-soft': 'oklch(56% .18 285/.1)', 'on-accent': 'oklch(100% 0 0)', glass: 'oklch(100% 0 0/1)', 'glass-bright': 'oklch(100% 0 0/1)',
      'glass-border': 'oklch(88% .005 280)', 'blob-a': 'oklch(70% .12 285/.16)', 'blob-b': 'oklch(68% .12 305/.14)', 'blob-c': 'oklch(72% .1 200/.14)',
      shadow: '0 1px 2px oklch(25% .01 280/.08)', 'shadow-sm': '0 1px 1px oklch(25% .01 280/.05)'
    },
    dark: {
      bg: 'oklch(16% .004 280)', 'bg-soft': 'oklch(19% .006 280)', surface: 'oklch(21% .006 280/1)', 'surface-strong': 'oklch(24% .008 280/1)',
      fg: 'oklch(94% .004 280)', muted: 'oklch(72% .008 280)', faint: 'oklch(56% .01 280)', border: 'oklch(100% 0 0/.08)', 'border-strong': 'oklch(100% 0 0/.16)',
      hover: 'oklch(94% .004 280/.05)', 'hover-strong': 'oklch(94% .004 280/.1)', accent: 'oklch(62% .17 285)', 'accent-strong': 'oklch(68% .16 285)',
      'accent-soft': 'oklch(62% .17 285/.14)', 'on-accent': 'oklch(14% .01 280)', glass: 'oklch(21% .006 280/1)', 'glass-bright': 'oklch(24% .008 280/1)',
      'glass-border': 'oklch(100% 0 0/.08)', 'blob-a': 'oklch(52% .13 285/.13)', 'blob-b': 'oklch(50% .13 305/.11)', 'blob-c': 'oklch(53% .11 200/.11)',
      shadow: '0 2px 6px oklch(0% 0 0/.4)', 'shadow-sm': '0 1px 3px oklch(0% 0 0/.3)'
    },
    layout: { 'r-lg': '6px', 'r-md': '5px', 'r-sm': '3px', 'font-body': 'Inter,-apple-system,"PingFang SC",system-ui,sans-serif' }
  },
  {
    id: 'market',
    name: '鲜活市集',
    desc: '活力橙 + 奶油白 + 牛油果绿 · 超大圆角',
    light: {
      bg: 'oklch(98% .01 85)', 'bg-soft': 'oklch(96% .015 85)', surface: 'oklch(100% 0 0/1)', 'surface-strong': 'oklch(100% 0 0/1)',
      fg: 'oklch(28% .03 45)', muted: 'oklch(48% .03 50)', faint: 'oklch(62% .02 55)', border: 'oklch(90% .02 80)', 'border-strong': 'oklch(82% .03 70)',
      hover: 'oklch(30% .03 60/.05)', 'hover-strong': 'oklch(30% .03 60/.1)', accent: 'oklch(62% .19 55)', 'accent-strong': 'oklch(56% .19 50)',
      'accent-soft': 'oklch(62% .19 55/.14)', 'on-accent': 'oklch(100% 0 0)', glass: 'oklch(100% 0 0/.72)', 'glass-bright': 'oklch(100% 0 0/.88)',
      'glass-border': 'oklch(100% 0 0/.9)', 'blob-a': 'oklch(78% .16 70/.3)', 'blob-b': 'oklch(72% .14 150/.26)', 'blob-c': 'oklch(80% .14 60/.24)',
      shadow: '0 20px 50px -20px oklch(40% .05 60/.35)', 'shadow-sm': '0 8px 24px -12px oklch(40% .05 60/.28)'
    },
    dark: {
      bg: 'oklch(20% .02 55)', 'bg-soft': 'oklch(24% .025 55)', surface: 'oklch(27% .028 55/.85)', 'surface-strong': 'oklch(30% .03 55/1)',
      fg: 'oklch(94% .01 80)', muted: 'oklch(74% .02 75)', faint: 'oklch(58% .02 70)', border: 'oklch(100% 0 0/.12)', 'border-strong': 'oklch(100% 0 0/.24)',
      hover: 'oklch(94% .01 80/.07)', 'hover-strong': 'oklch(94% .01 80/.13)', accent: 'oklch(72% .18 55)', 'accent-strong': 'oklch(78% .17 55)',
      'accent-soft': 'oklch(72% .18 55/.16)', 'on-accent': 'oklch(20% .03 50)', glass: 'oklch(27% .028 55/.7)', 'glass-bright': 'oklch(30% .03 55/.9)',
      'glass-border': 'oklch(100% 0 0/.14)', 'blob-a': 'oklch(60% .17 70/.2)', 'blob-b': 'oklch(55% .15 150/.18)', 'blob-c': 'oklch(62% .16 55/.18)',
      shadow: '0 20px 50px -20px oklch(0% 0 0/.6)', 'shadow-sm': '0 8px 24px -12px oklch(0% 0 0/.5)'
    },
    layout: { 'r-lg': '28px', 'r-md': '20px', 'r-sm': '14px' }
  },
  {
    id: 'editorial',
    name: '报纸极简',
    desc: '黑白灰 + 克制红 · 宋体标题 · 内容至上',
    light: {
      bg: 'oklch(98% .002 75)', 'bg-soft': 'oklch(96% .002 75)', surface: 'oklch(100% 0 0/1)', 'surface-strong': 'oklch(100% 0 0/1)',
      fg: 'oklch(18% .005 75)', muted: 'oklch(42% .008 75)', faint: 'oklch(55% .008 75)', border: 'oklch(90% .004 75)', 'border-strong': 'oklch(80% .005 75)',
      hover: 'oklch(20% .005 75/.04)', 'hover-strong': 'oklch(20% .005 75/.08)', accent: 'oklch(45% .16 25)', 'accent-strong': 'oklch(40% .16 25)',
      'accent-soft': 'oklch(45% .16 25/.1)', 'on-accent': 'oklch(100% 0 0)', glass: 'oklch(100% 0 0/.8)', 'glass-bright': 'oklch(100% 0 0/.95)',
      'glass-border': 'oklch(100% 0 0/1)', 'blob-a': 'oklch(70% .1 25/.1)', 'blob-b': 'oklch(70% .08 200/.08)', 'blob-c': 'oklch(72% .07 60/.08)',
      shadow: '0 1px 2px oklch(25% .01 75/.08)', 'shadow-sm': '0 1px 1px oklch(25% .01 75/.05)'
    },
    dark: {
      bg: 'oklch(15% .003 75)', 'bg-soft': 'oklch(18% .004 75)', surface: 'oklch(21% .005 75/1)', 'surface-strong': 'oklch(24% .006 75/1)',
      fg: 'oklch(94% .004 75)', muted: 'oklch(70% .006 75)', faint: 'oklch(54% .006 75)', border: 'oklch(100% 0 0/.1)', 'border-strong': 'oklch(100% 0 0/.18)',
      hover: 'oklch(94% .004 75/.05)', 'hover-strong': 'oklch(94% .004 75/.1)', accent: 'oklch(68% .15 25)', 'accent-strong': 'oklch(72% .14 25)',
      'accent-soft': 'oklch(68% .15 25/.14)', 'on-accent': 'oklch(15% .005 75)', glass: 'oklch(21% .005 75/1)', 'glass-bright': 'oklch(24% .006 75/1)',
      'glass-border': 'oklch(100% 0 0/.1)', 'blob-a': 'oklch(55% .12 25/.1)', 'blob-b': 'oklch(55% .1 200/.08)', 'blob-c': 'oklch(56% .09 60/.08)',
      shadow: '0 2px 6px oklch(0% 0 0/.45)', 'shadow-sm': '0 1px 3px oklch(0% 0 0/.35)'
    },
    layout: { 'r-lg': '8px', 'r-md': '6px', 'r-sm': '4px', 'font-display': '"Noto Serif SC","Songti SC",SimSun,serif' }
  },
  {
    id: 'neon',
    name: '霓虹暗夜',
    desc: '深蓝黑底 + 荧光蓝紫 · 沉浸',
    light: {
      bg: 'oklch(16% .02 260)', 'bg-soft': 'oklch(20% .025 265)', surface: 'oklch(23% .03 265/.9)', 'surface-strong': 'oklch(27% .035 265/1)',
      fg: 'oklch(94% .01 260)', muted: 'oklch(72% .02 260)', faint: 'oklch(58% .015 260)', border: 'oklch(100% 0 0/.12)', 'border-strong': 'oklch(100% 0 0/.22)',
      hover: 'oklch(94% .01 260/.07)', 'hover-strong': 'oklch(94% .01 260/.13)', accent: 'oklch(70% .2 290)', 'accent-strong': 'oklch(76% .19 290)',
      'accent-soft': 'oklch(70% .2 290/.18)', 'on-accent': 'oklch(14% .02 260)', glass: 'oklch(23% .03 265/.7)', 'glass-bright': 'oklch(27% .035 265/.9)',
      'glass-border': 'oklch(100% 0 0/.16)', 'blob-a': 'oklch(62% .22 300/.3)', 'blob-b': 'oklch(58% .2 250/.28)', 'blob-c': 'oklch(65% .2 200/.24)',
      shadow: '0 20px 50px -16px oklch(0% 0 0/.7)', 'shadow-sm': '0 8px 24px -10px oklch(0% 0 0/.6)'
    },
    dark: {
      bg: 'oklch(13% .02 260)', 'bg-soft': 'oklch(17% .025 265)', surface: 'oklch(20% .03 265/.9)', 'surface-strong': 'oklch(24% .035 265/1)',
      fg: 'oklch(95% .01 260)', muted: 'oklch(74% .02 260)', faint: 'oklch(60% .015 260)', border: 'oklch(100% 0 0/.12)', 'border-strong': 'oklch(100% 0 0/.22)',
      hover: 'oklch(95% .01 260/.06)', 'hover-strong': 'oklch(95% .01 260/.12)', accent: 'oklch(72% .22 295)', 'accent-strong': 'oklch(78% .21 295)',
      'accent-soft': 'oklch(72% .22 295/.2)', 'on-accent': 'oklch(12% .02 260)', glass: 'oklch(20% .03 265/.75)', 'glass-bright': 'oklch(24% .035 265/.95)',
      'glass-border': 'oklch(100% 0 0/.16)', 'blob-a': 'oklch(64% .23 300/.26)', 'blob-b': 'oklch(60% .21 250/.24)', 'blob-c': 'oklch(67% .2 200/.2)',
      shadow: '0 20px 50px -16px oklch(0% 0 0/.75)', 'shadow-sm': '0 8px 24px -10px oklch(0% 0 0/.65)'
    },
    layout: { 'r-lg': '16px', 'r-md': '12px', 'r-sm': '8px' }
  },
  {
    id: 'industrial',
    name: '重工沉稳',
    desc: '深灰藏蓝 + 工程黄 · 直角硬线条',
    light: {
      bg: 'oklch(97% .006 240)', 'bg-soft': 'oklch(94% .008 240)', surface: 'oklch(100% 0 0/1)', 'surface-strong': 'oklch(100% 0 0/1)',
      fg: 'oklch(22% .012 240)', muted: 'oklch(45% .014 240)', faint: 'oklch(58% .012 240)', border: 'oklch(88% .008 240)', 'border-strong': 'oklch(78% .012 240)',
      hover: 'oklch(22% .012 240/.04)', 'hover-strong': 'oklch(22% .012 240/.08)', accent: 'oklch(52% .16 90)', 'accent-strong': 'oklch(47% .16 90)',
      'accent-soft': 'oklch(52% .16 90/.12)', 'on-accent': 'oklch(15% .02 240)', glass: 'oklch(100% 0 0/.85)', 'glass-bright': 'oklch(100% 0 0/.97)',
      'glass-border': 'oklch(100% 0 0/1)', 'blob-a': 'oklch(70% .12 90/.16)', 'blob-b': 'oklch(70% .1 230/.12)', 'blob-c': 'oklch(72% .09 200/.12)',
      shadow: '0 4px 12px oklch(30% .02 240/.12)', 'shadow-sm': '0 2px 6px oklch(30% .02 240/.08)'
    },
    dark: {
      bg: 'oklch(15% .012 240)', 'bg-soft': 'oklch(18% .014 240)', surface: 'oklch(22% .016 240/1)', 'surface-strong': 'oklch(25% .018 240/1)',
      fg: 'oklch(93% .008 240)', muted: 'oklch(72% .012 240)', faint: 'oklch(56% .012 240)', border: 'oklch(100% 0 0/.1)', 'border-strong': 'oklch(100% 0 0/.18)',
      hover: 'oklch(93% .008 240/.05)', 'hover-strong': 'oklch(93% .008 240/.1)', accent: 'oklch(68% .17 90)', 'accent-strong': 'oklch(72% .16 90)',
      'accent-soft': 'oklch(68% .17 90/.15)', 'on-accent': 'oklch(15% .02 240)', glass: 'oklch(22% .016 240/1)', 'glass-bright': 'oklch(25% .018 240/1)',
      'glass-border': 'oklch(100% 0 0/.1)', 'blob-a': 'oklch(60% .14 90/.14)', 'blob-b': 'oklch(60% .12 230/.1)', 'blob-c': 'oklch(62% .11 200/.1)',
      shadow: '0 4px 12px oklch(0% 0 0/.5)', 'shadow-sm': '0 2px 6px oklch(0% 0 0/.4)'
    },
    layout: { 'r-lg': '6px', 'r-md': '4px', 'r-sm': '2px' }
  }
]

/** 「官方默认」就是内置 token 本身，不注入覆盖层 */
export const BUILTIN_PRESET_ID = 'default'
