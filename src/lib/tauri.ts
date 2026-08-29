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

export const TARGET_LANGUAGES: [string, string][] = [
  ['en-GB', 'English (UK)'],
  ['en-US', 'English (US)'],
  ['es-ES', 'Spanish (Spain)'],
  ['fr-FR', 'French'],
  ['it-IT', 'Italian'],
  ['pt-PT', 'Portuguese (Portugal)'],
  ['de-DE', 'German'],
  ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'],
  ['zh-CN', 'Chinese (Simplified)'],
]

export const NATIVE_LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['de', 'German'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
]

export function getSettings(): Promise<Settings> {
  return invoke<Settings>('get_settings')
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke('save_settings', { settings })
}

export function generateStory(level: Level): Promise<Story> {
  return invoke('generate_story', { level })
}

export function transcribeAudio(audioBase64: string): Promise<string> {
  return invoke('transcribe_audio', { audioBase64 })
}

export function getPlan(): Promise<ObserverDocuments> {
  return invoke('get_plan')
}

export { logDebug, logError, logInfo, logWarn }
