import { logDebug, logError, logInfo, logWarn } from './log'
import type { Level, ObserverDocuments, Settings, Story } from '../types'

export const isTauri =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

function summarize(args?: Record<string, unknown>): string {
  if (!args) return '{}'
  try {
    const json = JSON.stringify(args, (_k, v) =>
      typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…(${v.length}ch)` : v
    )
    return json.length > 400 ? `${json.slice(0, 400)}…` : json
  } catch {
    return '<unserializable>'
  }
}

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  const started = performance.now()
  logDebug(`[ipc] ${cmd} →`, summarize(args))
  try {
    const result = await invoke<T>(cmd, args)
    logDebug(`[ipc] ${cmd} ✓ ${(performance.now() - started).toFixed(0)}ms`)
    return result
  } catch (e) {
    logError(`[ipc] ${cmd} ✗ ${(performance.now() - started).toFixed(0)}ms:`, e)
    throw e
  }
}

/// Single language registry — every entry works as BOTH target and native.
/// `code` is the BCP-47 value stored for target_language; `base` is the
/// value stored for native_language (and the UI language, lib/i18n.ts).
/// `dialects` are regional variants (first = default); `direction` and
/// `romanization` follow the target script (RTL + ALA-LC for Arabic).
export const LANGUAGES: {
  code: string
  base: string
  name: string
  direction: 'ltr' | 'rtl'
  romanization: string | null
  dialects: { id: string; label: string }[]
}[] = [
  {
    code: 'en-US',
    base: 'en',
    name: 'English (US)',
    direction: 'ltr',
    romanization: null,
    dialects: [{ id: 'en-US', label: 'Standard American' }],
  },
  {
    code: 'fr-FR',
    base: 'fr',
    name: 'Français',
    direction: 'ltr',
    romanization: null,
    dialects: [
      { id: 'fr-FR', label: 'France (standard)' },
      { id: 'fr-CA', label: 'Québécois' },
    ],
  },
  {
    code: 'es-ES',
    base: 'es',
    name: 'Español',
    direction: 'ltr',
    romanization: null,
    dialects: [
      { id: 'es-ES', label: 'España (peninsular)' },
      { id: 'es-MX', label: 'Mexicano' },
      { id: 'es-AR', label: 'Rioplatense' },
    ],
  },
  {
    code: 'ar-LE',
    base: 'ar',
    name: 'العربية (Levantine)',
    direction: 'rtl',
    romanization: 'ALA-LC',
    dialects: [
      { id: 'ar-LE', label: 'Levantine' },
      { id: 'ar-EG', label: 'Egyptian' },
      { id: 'ar-MSA', label: 'Modern Standard' },
    ],
  },
]

export function getSettings(): Promise<Settings> {
  return invoke<Settings>('get_settings')
}

export interface KeyStatus {
  valid: boolean
  detail: string
}

export function validateKey(
  provider: 'openrouter' | 'groq',
  key: string
): Promise<KeyStatus> {
  return invoke('validate_key', { provider, key })
}

export function getDiagnostics(): Promise<[string, number][]> {
  return invoke('get_diagnostics')
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke('save_settings', { settings })
}

export function generateStory(level: Level): Promise<Story> {
  return invoke('generate_story', { level })
}

export function transcribeAudio(
  audioBase64: string,
  prompt?: string
): Promise<string> {
  return invoke('transcribe_audio', { audioBase64, prompt: prompt ?? null })
}

export function getPlan(): Promise<ObserverDocuments> {
  return invoke('get_plan')
}

export { logDebug, logError, logInfo, logWarn }
