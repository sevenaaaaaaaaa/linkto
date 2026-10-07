import { PROVIDER_PRESETS, ACCOUNT_COLORS } from '@shared/presets'

export { PROVIDER_PRESETS, ACCOUNT_COLORS }

export function presetFor(email: string) {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  return (
    PROVIDER_PRESETS.find(p => p.key !== 'custom' && p.domains.includes(domain)) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
  )
}
