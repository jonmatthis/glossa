import { Component, useEffect, useState, type ReactNode } from 'react'
import type { Settings } from './types'
import { isTauri } from './lib/tauri'
import GuidedPage from './pages/GuidedPage'
import StoriesPage from './pages/StoriesPage'
import { SettingsModal } from './components/SettingsModal'
import { LogsOverlay } from './components/LogsOverlay'

type Page = 'guided' | 'stories'

// Keeps a render crash from blanking the whole app.
class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="not-tauri">
          This view crashed: {this.state.error.message}
          <br />
          <br />
          <button
            type="button"
            className="btn"
            onClick={() => this.setState({ error: null })}
          >
            Reload view
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

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
          <PageBoundary>
            <GuidedPage />
          </PageBoundary>
        ) : (
          <PageBoundary>
            <StoriesPage />
          </PageBoundary>
        )}
      </div>

      <LogsOverlay />

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
