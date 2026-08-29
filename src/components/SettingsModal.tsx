import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../types'
import {
  getSettings,
  logError,
  logInfo,
  logWarn,
  saveSettings,
  NATIVE_LANGUAGES,
  TARGET_LANGUAGES,
} from '../lib/tauri'

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
        <div className="modal" onClick={(e) => e.stopPropagation()}>
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
          <input
            type="password"
            value={settings.openrouter_key}
            placeholder="sk-or-..."
            onChange={(e) => setSettings({ ...settings, openrouter_key: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label>Groq API key (speech-to-text)</label>
          <input
            type="password"
            value={settings.groq_key}
            placeholder="gsk_..."
            onChange={(e) => setSettings({ ...settings, groq_key: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label>Model (OpenRouter)</label>
          <input
            value={settings.openrouter_model}
            onChange={(e) => setSettings({ ...settings, openrouter_model: e.target.value })}
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
