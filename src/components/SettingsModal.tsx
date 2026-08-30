import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../types'
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
import { comboFromEvent, SHORTCUT_DEFAULTS } from '../lib/keyboard'

type KeyCheck = { state: 'idle' | 'checking' | 'valid' | 'invalid'; detail: string }

/// Shortcut recorder: click to arm, press a combo, Esc clears back to default.
function ShortcutField({
  label,
  value,
  onChange,
}: {
  label: string
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
        value={recording ? 'press keys…' : value}
        readOnly
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') {
            onChange(SHORTCUT_DEFAULTS[label.toLowerCase().replace(/[^a-z]/g, '') as keyof typeof SHORTCUT_DEFAULTS] ?? '')
            ;(e.target as HTMLInputElement).blur()
            return
          }
          if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta')
            return
          const combo = comboFromEvent(e)
          onChange(combo)
          ;(e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}

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

  // Validate both keys as soon as they change (debounced) — including on
  // first load, so the user immediately sees whether stored keys are live.
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
    void listMics()
  }, [])

  const listMics = useCallback(async () => {
    try {
      // Request permission briefly so device labels are populated.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter((d) => d.kind === 'audioinput')
      setMics(inputs)
      logInfo(
        '[settings] microphones:',
        inputs.map((d, i) => `${i}: ${d.label || '(unlabeled)'} [${d.deviceId.slice(0, 8)}…]`)
      )
    } catch (e) {
      logWarn('[settings] microphone enumeration failed:', e)
    }
  }, [])

  const save = useCallback(async () => {
    if (!settings) return
    setSaving(true)
    logInfo('[settings] saving', {
      target: settings.target_language,
      native: settings.native_language,
      model: settings.openrouter_model,
      mic: settings.microphone_device_id ?? '(default)',
    })
    try {
      await saveSettings(settings)
      logInfo('[settings] saved ✓')
      onSaved(settings)
    } catch (e) {
      logError('[settings] save failed:', e)
    } finally {
      setSaving(false)
    }
  }, [settings, onSaved])

  if (!settings) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div
          className="modal"
          onClick={(e) => e.stopPropagation()}
          onFocusCapture={(e) => {
            // With the keyboard open, keep the focused field visible.
            const t = e.target as HTMLElement
            if (t.tagName === 'INPUT' || t.tagName === 'SELECT') {
              t.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
            }
          }}
        >
          <p className="center-note">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p className="sub">
          Keys are stored locally on this machine and sent only to the
          corresponding providers. OpenRouter powers the tutor and stories;
          Groq powers speech-to-text.
        </p>
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
        <div className="form-row">
          <label>Model (OpenRouter)</label>
          <input
            value={settings.openrouter_model}
            onChange={(e) => setSettings({ ...settings, openrouter_model: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label>Observer model (reasoning — steers the tutor)</label>
          <input
            value={settings.observer_model ?? ''}
            placeholder="(same as tutor model)"
            onChange={(e) =>
              setSettings({ ...settings, observer_model: e.target.value || null })
            }
          />
        </div>
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
        <div className="form-row">
          <label>Keyboard shortcuts (click a field, press the combo; Esc resets to default)</label>
          <div className="shortcut-grid">
            <ShortcutField
              label="Mic"
              value={settings.shortcuts.mic}
              onChange={(v) =>
                setSettings({ ...settings, shortcuts: { ...settings.shortcuts, mic: v } })
              }
            />
            <ShortcutField
              label="Speak last reply"
              value={settings.shortcuts.speak}
              onChange={(v) =>
                setSettings({ ...settings, shortcuts: { ...settings.shortcuts, speak: v } })
              }
            />
            <ShortcutField
              label="Toggle analysis panel"
              value={settings.shortcuts.panel}
              onChange={(v) =>
                setSettings({ ...settings, shortcuts: { ...settings.shortcuts, panel: v } })
              }
            />
            <ShortcutField
              label="Open settings"
              value={settings.shortcuts.settings}
              onChange={(v) =>
                setSettings({ ...settings, shortcuts: { ...settings.shortcuts, settings: v } })
              }
            />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
