import { isTauri } from './tauri'

type Level = 'debug' | 'info' | 'warn' | 'error'

async function toPlugin(level: Level, args: unknown[]) {
  if (!isTauri) return
  try {
    const plugin = await import('@tauri-apps/plugin-log')
    const message = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
    const fn =
      level === 'debug'
        ? plugin.debug
        : level === 'warn'
          ? plugin.warn
          : level === 'error'
            ? plugin.error
            : plugin.info
    await fn(message)
  } catch {
    /* logging must never break the app */
  }
}

export function logDebug(...args: unknown[]) {
  console.debug(...args)
  void toPlugin('debug', args)
}

export function logInfo(...args: unknown[]) {
  console.log(...args)
  void toPlugin('info', args)
}

export function logWarn(...args: unknown[]) {
  console.warn(...args)
  void toPlugin('warn', args)
}

export function logError(...args: unknown[]) {
  console.error(...args)
  void toPlugin('error', args)
}
