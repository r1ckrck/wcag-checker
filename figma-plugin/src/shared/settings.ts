// Per-user AI settings persisted via `figma.clientStorage` (per Figma user
// account, scoped to this plugin id, survives plugin reloads + Figma
// restarts). Single record, single storage key.
//
// `apiKey === ''` → "needs setup" — header indicator surfaces this state and
// the AI sections render their setup-required closed bar.
// `model === ''` → use the registry's default model for the active provider.
// `aiEnabled` is independent of `apiKey`: a user can clear AI without losing
// their key, then turn it back on without re-pasting.

export type ProviderId = 'openrouter' | 'anthropic' | 'google'

export interface AiSettings {
  provider: ProviderId
  apiKey: string
  model: string
  aiEnabled: boolean
}

/** Versioned key — bump if the shape changes so old records don't crash
 *  the loader. The loader treats unknown shapes as "no settings yet". */
export const SETTINGS_STORAGE_KEY = 'maanak.settings.v1'

/** Pre-rebrand key. Read once by the main-thread migration shim so users
 *  who saved a key under the old "WCAG AA Auditor" name keep it. Never
 *  written to again. */
export const LEGACY_SETTINGS_STORAGE_KEY = 'wcag-aa-auditor.settings.v1'

export const DEFAULT_SETTINGS: AiSettings = {
  provider: 'openrouter',
  apiKey: '',
  model: '',
  aiEnabled: false,
}

/** All recognised provider ids. Imported by the main thread's sanitiser
 *  (validate before save) and by the settings page (build the tab list). */
export const PROVIDER_IDS: readonly ProviderId[] = ['openrouter', 'anthropic', 'google']

/** Defensive parse — accept any shape, drop unknown fields, fall back to
 *  defaults on missing/wrong types. Never throws. Used on the main thread
 *  after `figma.clientStorage.getAsync` returns. */
export function parseSettings(raw: unknown): AiSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_SETTINGS
  const r = raw as Record<string, unknown>
  const provider = PROVIDER_IDS.includes(r.provider as ProviderId)
    ? (r.provider as ProviderId)
    : DEFAULT_SETTINGS.provider
  const apiKey = typeof r.apiKey === 'string' ? r.apiKey : DEFAULT_SETTINGS.apiKey
  const model = typeof r.model === 'string' ? r.model : DEFAULT_SETTINGS.model
  const aiEnabled = typeof r.aiEnabled === 'boolean' ? r.aiEnabled : DEFAULT_SETTINGS.aiEnabled
  return { provider, apiKey, model, aiEnabled }
}
