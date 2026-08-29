import { useEffect, useState } from 'react'
import type { Settings } from './types'
import { isTauri } from './lib/tauri'
import GuidedPage from './pages/GuidedPage'
import StoriesPage from './pages/StoriesPage'
import { SettingsModal } from './components/SettingsModal'

type Page = 'guided' | 'stories'

export default function App() {
  const [page, setPage] = useState<Page>('guided')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [, setSettings] = useState<Settings | null>(null)
  const [showNotTauri, setShowNotTauri] = useState(false)

  useEffect(() => {
    if (!isTauri) {
      setShowNotTauri(true)
      return
    }
    void import('./lib/tauri').then(({ getSettings }) =>
      getSettings()
        .then((s) => {
          setSettings(s)
          localStorage.setItem('glossa_target', s.target_language)
        })
        .catch(() => {})
    )
  }, [])

  return (
    <div className="app">
      <div className="topbar">
        <span className="wordmark">
          GLOSSA<b>·</b>
        </span>
        <div className="tabs">
          <button
            type="button"
            className={`tab ${page === 'guided' ? 'active' : ''}`}
            onClick={() => setPage('guided')}
          >
            Guided
          </button>
          <button
            type="button"
            className={`tab ${page === 'stories' ? 'active' : ''}`}
            onClick={() => setPage('stories')}
          >
            Stories
          </button>
        </div>
        <button
          type="button"
          className="gear"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          title="Settings"
        >
          ⚙
        </button>
      </div>

      <div className="content">
        {showNotTauri ? (
          <div className="not-tauri">
            This is the Glossa desktop app UI. Run it with{' '}
            <b>npm run tauri dev</b> from the glossa folder — the interface
            needs the Rust core for AI calls, storage, and speech-to-text.
          </div>
        ) : page === 'guided' ? (
          <GuidedPage />
        ) : (
          <StoriesPage />
        )}
      </div>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => {
            setSettings(s)
            localStorage.setItem('glossa_target', s.target_language)
            setSettingsOpen(false)
          }}
        />
      )}
    </div>
  )
}
