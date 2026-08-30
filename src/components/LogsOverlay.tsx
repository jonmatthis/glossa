import { useEffect, useRef, useState } from 'react'
import { clearLogs, getLogs, subscribeLogs, type LogEntry } from '../lib/log'
import { getDiagnostics } from '../lib/tauri'

const COLORS: Record<string, string> = {
  debug: 'var(--faint-d)',
  info: 'var(--mut-d)',
  warn: 'var(--amber)',
  error: '#e06c6c',
}

// Floating debug console: a small toggle button that pulls up a scrolling
// log sheet from the bottom of the screen. Lives outside the page layout so
// it works identically on desktop and mobile.
export function LogsOverlay() {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<LogEntry[]>([...getLogs()])
  const [stats, setStats] = useState<[string, number][] | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  useEffect(() => subscribeLogs((e) => setEntries([...e])), [])
  useEffect(() => {
    if (open) {
      void getDiagnostics()
        .then(setStats)
        .catch(() => setStats(null))
    }
  }, [open])
  useEffect(() => {
    if (open && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [entries, open])

  return (
    <>
      <button
        type="button"
        className={`logs-fab ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Toggle logs"
        aria-label="Toggle logs"
      >
        {open ? '▾' : 'log'}
      </button>
      {open && (
        <div className="logs-panel">
          <div className="logs-head">
            <span>Logs</span>
            {stats && stats.some(([, v]) => v > 0) && (
              <span className="logs-stats">
                {stats
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ')}
              </span>
            )}
            <button type="button" className="logs-clear" onClick={() => clearLogs()}>
              clear
            </button>
          </div>
          <div className="logs-body" ref={scroller}>
            {entries.length === 0 && <div className="logs-line">— no logs —</div>}
            {entries.map((e, i) => (
              <div key={i} className="logs-line" style={{ color: COLORS[e.level] }}>
                <span className="logs-t">
                  {new Date(e.ts).toLocaleTimeString(undefined, { hour12: false })}
                </span>{' '}
                {e.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
