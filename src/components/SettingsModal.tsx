import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Settings, Shortcuts } from '../types'
import {
  getSettings,
  logError,
  logInfo,
  logWarn,
  saveSettings,
  validateKey,
  NATIVE_LANGUAGES,
  TARGET_LANGUAGES,
} from '../lib/tauri'
import { comboFromEvent, SHORTCUT_DEFAULTS, type ShortcutAction } from '../lib/keyboard'

type KeyCheck = { state: 'idle' | 'checking' | 'valid' | 'invalid'; detail: string }

type SectionId = 'keys' | 'models' | 'languages' | 'voice' | 'shortcuts'

function KeyBadge({ check }: { check: KeyCheck }) {
  if (check.state === 'idle') return null
  if (check.state === 'checking')
    return (
      <span className="key-badge checking" title="checking key…">
        ⟳
      </span>
    )
  if (check.state === 'valid')
    return (
      <span className="key-badge valid" title={`Key valid — ${check.detail}`}>
        ✓
      </span>
    )
  return (
    <span className="key-badge invalid" title={check.detail}>
      ✕
    </span>
  )
}

/// Shortcut recorder: click to arm, press a combo. Esc resets to default.
function ShortcutField({
  label,
  action,
  value,
  onChange,
}: {
  label: string
  action: ShortcutAction
  value: string
  onChange: (v: string) => void
}) {
  const [recording, setRecording] = useState(false)
  return (
    <div className="shortcut-field">
      <span className="shortcut-label">{label}</span>
      <input
        data-shortcut-capture={recording || undefined}
        className="shortcut-input"
        value={recording ? 'press keys…' : value || SHORTCUT_DEFAULTS[action]}
        readOnly
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') {
            onChange(SHORTCUT_DEFAULTS[action])
            ;(e.target as HTMLInputElement).blur()
            return
          }
          if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta')
            return
          onChange(comboFromEvent(e))
          ;(e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}

const SECTIONS: { id: SectionId; label: string; icon: string; desc: string }[] = [
  {
    id: 'keys',
    label: 'API Keys',
    icon: '🔑',
    desc: 'Provider credentials. Stored locally, sent only to the provider, never shown after saving.',
  },
  {
    id: 'models',
    label: 'Models',
    icon: '🧠',
    desc: 'Which models power the tutor/analysis workers and the reasoning observer.',
  },
  {
    id: 'languages',
    label: 'Languages',
    icon: '🌐',
    desc: "What you're learning and what you already speak.",
  },
  {
    id: 'voice',
    label: 'Audio & Voice',
    icon: '🎙',
    desc: 'Microphone, speech playback, and transcription behavior.',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: '⌨',
    desc: 'Click a field and press the combo. Esc resets to default.',
  },
]

const SECTION_LABEL: Record<SectionId, string> = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s.label])
) as Record<SectionId, string>

interface RowDef {
  section: SectionId
  label: string
  kw: string
  node: ReactNode
}

const SHORTCUT_ROWS: { action: ShortcutAction; label: string }[] = [
  { action: 'mic', label: 'Toggle microphone' },
  { action: 'speak', label: 'Speak last reply' },
  { action: 'panel', label: 'Toggle analysis panel' },
  { action: 'settings', label: 'Open settings' },
]

export function SettingsModal({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (s: Settings) => void
}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [openrouterCheck, setOpenrouterCheck] = useState<KeyCheck>({ state: 'idle', detail: '' })
  const [groqCheck, setGroqCheck] = useState<KeyCheck>({ state: 'idle', detail: '' })
  const [section, setSection] = useState<SectionId>('keys')
  const [search, setSearch] = useState('')

  useEffect(() => {
    logInfo('[settings] modal opened')
    void getSettings()
      .then((s) => {
        setSettings(s)
        logInfo('[settings] loaded', {
          target: s.target_language,
          native: s.native_language,
          model: s.openrouter_model,
          openrouterKey: s.openrouter_key ? 'set' : 'MISSING',
          groqKey: s.groq_key ? 'set' : 'MISSING',
        })
      })
      .catch((e) => {
        logError('[settings] load failed:', e)
        setSettings(null)
      })
  }, [])

  const listMics = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      const devices = await navigator.mediaDevices.enumerateDevices()
      setMics(devices.filter((d) => d.kind === 'audioinput'))
    } catch (e) {
      logWarn('[settings] microphone enumeration failed:', e)
    }
  }, [])

  // Mic enumeration only when the Audio section is visited — opening
  // Settings no longer trips the mic-permission prompt as a side effect.
  useEffect(() => {
    if (section === 'voice') void listMics()
  }, [section, listMics])

  // Validate both keys as they change (debounced) — including on first load.
  useEffect(() => {
    const key = settings?.openrouter_key
    if (key === undefined) return
    if (!key.trim()) {
      setOpenrouterCheck({ state: 'idle', detail: '' })
      return
    }
    setOpenrouterCheck({ state: 'checking', detail: '' })
    const t = setTimeout(() => {
      void validateKey('openrouter', key)
        .then((s) =>
          setOpenrouterCheck({ state: s.valid ? 'valid' : 'invalid', detail: s.detail })
        )
        .catch((e) => setOpenrouterCheck({ state: 'invalid', detail: String(e) }))
    }, 600)
    return () => clearTimeout(t)
  }, [settings?.openrouter_key])

  useEffect(() => {
    const key = settings?.groq_key
    if (key === undefined) return
    if (!key.trim()) {
      setGroqCheck({ state: 'idle', detail: '' })
      return
    }
    setGroqCheck({ state: 'checking', detail: '' })
    const t = setTimeout(() => {
      void validateKey('groq', key)
        .then((s) => setGroqCheck({ state: s.valid ? 'valid' : 'invalid', detail: s.detail }))
        .catch((e) => setGroqCheck({ state: 'invalid', detail: String(e) }))
    }, 600)
    return () => clearTimeout(t)
  }, [settings?.groq_key])

  const save = useCallback(async () => {
    if (!settings) return
    setSaving(true)
    logInfo('[settings] saving', {
      target: settings.target_language,
      native: settings.native_language,
      model: settings.openrouter_model,
    })
    try {
      await saveSettings(settings)
      logInfo('[settings] saved ✓')
      onSaved(settings)
    } catch (e) {
      logError('[settings] save failed:', e)
      setSaving(false)
    }
  }, [settings, onSaved])

  if (!settings) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <p className="center-note">Loading…</p>
        </div>
      </div>
    )
  }

  const setShortcuts = (patch: Partial<Shortcuts>) =>
    setSettings({ ...settings, shortcuts: { ...settings.shortcuts, ...patch } })

  // ── Row registry: adding a setting = one entry here ──────────────────────
  const rows: Record<string, RowDef> = {
    openrouter_key: {
      section: 'keys',
      label: 'OpenRouter API key',
      kw: 'openrouter api key credential token chat tutor',
      node: (
        <div className="form-row">
          <label>OpenRouter API key</label>
          <div className="key-row">
            <input
              type="password"
              value={settings.openrouter_key}
              placeholder="sk-or-..."
              onChange={(e) => setSettings({ ...settings, openrouter_key: e.target.value })}
            />
            <KeyBadge check={openrouterCheck} />
          </div>
        </div>
      ),
    },
    groq_key: {
      section: 'keys',
      label: 'Groq API key',
      kw: 'groq api key credential speech transcription stt whisper voice',
      node: (
        <div className="form-row">
          <label>Groq API key (speech-to-text)</label>
          <div className="key-row">
            <input
              type="password"
              value={settings.groq_key}
              placeholder="gsk_..."
              onChange={(e) => setSettings({ ...settings, groq_key: e.target.value })}
            />
            <KeyBadge check={groqCheck} />
          </div>
        </div>
      ),
    },
    worker_model: {
      section: 'models',
      label: 'Worker model (tutor · analysis · coach)',
      kw: 'worker model llm gemini openai deepseek tutor analysis speed',
      node: (
        <div className="form-row">
          <label>Worker model</label>
          <input
            value={settings.openrouter_model}
            onChange={(e) => setSettings({ ...settings, openrouter_model: e.target.value })}
          />
        </div>
      ),
    },
    observer_model: {
      section: 'models',
      label: 'Observer model (reasoning · planning)',
      kw: 'observer model reasoning planning coach agent',
      node: (
        <div className="form-row">
          <label>Observer model</label>
          <input
            value={settings.observer_model ?? ''}
            placeholder="(same as worker model)"
            onChange={(e) =>
              setSettings({ ...settings, observer_model: e.target.value || null })
            }
          />
        </div>
      ),
    },
    target_language: {
      section: 'languages',
      label: 'I want to learn',
      kw: 'target language learn spanish studying',
      node: (
        <div className="form-row">
          <label>I want to learn</label>
          <select
            value={settings.target_language}
            onChange={(e) => setSettings({ ...settings, target_language: e.target.value })}
          >
            {TARGET_LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ),
    },
    native_language: {
      section: 'languages',
      label: 'My native language',
      kw: 'native language explanations mother tongue',
      node: (
        <div className="form-row">
          <label>My native language</label>
          <select
            value={settings.native_language}
            onChange={(e) => setSettings({ ...settings, native_language: e.target.value })}
          >
            {NATIVE_LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ),
    },
    microphone: {
      section: 'voice',
      label: 'Microphone',
      kw: 'microphone input device recording yeti',
      node: (
        <div className="form-row">
          <label>Microphone</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={settings.microphone_device_id ?? ''}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  microphone_device_id: e.target.value || null,
                })
              }
            >
              <option value="">System default</option>
              {mics.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => void listMics()}>
              ↻
            </button>
          </div>
        </div>
      ),
    },
    auto_speak: {
      section: 'voice',
      label: 'Auto-speak tutor replies',
      kw: 'auto speak tts voice speech playback audio read aloud',
      node: (
        <div className="form-row check-row">
          <label className="check-label">
            <input
              type="checkbox"
              checked={settings.auto_speak}
              onChange={(e) => setSettings({ ...settings, auto_speak: e.target.checked })}
            />
            <span>Auto-speak tutor replies (OS voice, free &amp; offline)</span>
          </label>
        </div>
      ),
    },
    auto_send: {
      section: 'voice',
      label: 'Auto-send transcriptions',
      kw: 'auto send transcription mic speech stt voice input',
      node: (
        <div className="form-row check-row">
          <label className="check-label">
            <input
              type="checkbox"
              checked={settings.auto_send}
              onChange={(e) => setSettings({ ...settings, auto_send: e.target.checked })}
            />
            <span>Auto-send transcriptions (mic → send immediately)</span>
          </label>
        </div>
      ),
    },
  }
  for (const sr of SHORTCUT_ROWS) {
    rows[`shortcut_${sr.action}`] = {
      section: 'shortcuts',
      label: sr.label,
      kw: `keyboard shortcut hotkey key combo ${sr.label}`,
      node: (
        <div className="form-row">
          <ShortcutField
            label={sr.label}
            action={sr.action}
            value={settings.shortcuts[sr.action]}
            onChange={(v) => setShortcuts({ [sr.action]: v })}
          />
        </div>
      ),
    }
  }

  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const allRows = Object.entries(rows)
  const visibleRows = searching
    ? allRows.filter(
        ([, r]) => r.label.toLowerCase().includes(q) || r.kw.includes(q)
      )
    : allRows.filter(([, r]) => r.section === section)

  const activeSection = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        onFocusCapture={(e) => {
          const t = e.target as HTMLElement
          if (t.tagName === 'INPUT' || t.tagName === 'SELECT') {
            t.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
          }
        }}
      >
        <aside className="settings-nav">
          <input
            className="settings-search"
            placeholder="Search settings…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search settings"
          />
          <nav className="settings-tree">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`nav-item ${!searching && section === s.id ? 'active' : ''}`}
                onClick={() => {
                  setSearch('')
                  setSection(s.id)
                }}
              >
                <span className="nav-icon">{s.icon}</span>
                {s.label}
              </button>
            ))}
          </nav>
        </aside>
        <main className="settings-content">
          <div className="settings-head">
            <h2>{searching ? `Search: “${search.trim()}”` : activeSection.label}</h2>
            <p className="sub">
              {searching
                ? `${visibleRows.length} match${visibleRows.length === 1 ? '' : 'es'}`
                : activeSection.desc}
            </p>
          </div>
          <div className="settings-scroll">
            {searching && visibleRows.length === 0 && (
              <p className="center-note">Nothing matches “{search.trim()}”.</p>
            )}
            {visibleRows.map(([id, row]) => (
              <div key={id} className="settings-entry">
                {searching && (
                  <p className="settings-group-k">{SECTION_LABEL[row.section]}</p>
                )}
                {row.node}
              </div>
            ))}
            {!searching && visibleRows.length === 0 && (
              <p className="center-note">Nothing here yet.</p>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </main>
      </div>
    </div>
  )
}
