import { useCallback, useEffect, useRef, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  AssistLevel,
  GuidedEvent,
  GuidedTurnResult,
  Profile,
  Settings,
  Scaffolds,
  TeachingPlan,
} from '../types'
import { getPlan, getSettings, isTauri, transcribeAudio } from '../lib/tauri'
import { logDebug, logError, logInfo, logWarn } from '../lib/log'
import { needsSpaceBetween } from '../lib/token-spacing'

interface Turn {
  id: number
  user: string | null
  assistant: GuidedTurnResult | null
  pendingText: string
  analysisState: 'pending' | 'done' | 'failed' | null
}

const ASSIST_STORAGE_KEY = 'glossa_assist'
const ASSIST_LABELS: Record<AssistLevel, string> = {
  0: 'Immersion',
  1: 'Light',
  2: 'Guided',
  3: 'Full support',
}
const ASSIST_HINTS: Record<AssistLevel, string> = {
  0: 'Only the language you are learning. Write freely — the breakdown panel has your back.',
  1: 'Key words are underlined. Use the sentence starters to get going.',
  2: 'Every word has its meaning underneath. Fill in the blanks to build your reply.',
  3: 'Full translation shown. Tap a whole reply to send it — hold a conversation before you can build one.',
}

export default function GuidedPage() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [assist, setAssist] = useState<AssistLevel>(3)
  const [pinnedId, setPinnedId] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [plan, setPlan] = useState<TeachingPlan | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [planOpen, setPlanOpen] = useState(false)

  const streamRef = useRef<HTMLDivElement | null>(null)
  const greetedRef = useRef(false)
  const nextIdRef = useRef(1)
  const turnsRef = useRef<Turn[]>([])
  turnsRef.current = turns
  const recorderRef = useRef<MediaRecorder | null>(null)

  useEffect(() => {
    logInfo('[guided] page mounted, isTauri =', isTauri)
    const stored = localStorage.getItem(ASSIST_STORAGE_KEY)
    if (stored === '0' || stored === '1' || stored === '2' || stored === '3') {
      setAssist(Number(stored) as AssistLevel)
      logInfo('[guided] restored assist level:', stored)
    }
    void getSettings()
      .then((s) => {
        setSettings(s)
        logInfo('[guided] settings:', {
          target: s.target_language,
          native: s.native_language,
          model: s.openrouter_model,
          openrouterKey: s.openrouter_key ? 'set' : 'MISSING',
          groqKey: s.groq_key ? 'set' : 'MISSING',
        })
      })
      .catch((e) => logWarn('[guided] settings load failed:', e))
    void getPlan()
      .then((docs) => {
        setPlan(docs.plan)
        setProfile(docs.profile)
        logInfo('[guided] plan loaded:', {
          focus: docs.plan.session_focus,
          errors: docs.plan.recurring_errors.length,
        })
      })
      .catch((e) => logWarn('[guided] plan load failed:', e))
  }, [])

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  const requestTurn = useCallback(
    async (body: { message?: string; greeting?: boolean }) => {
      setSending(true)
      setError(null)
      logInfo('[guided] turn start:', {
        greeting: body.greeting ?? false,
        message: body.message ?? '',
        assist,
      })
      const pendingId = nextIdRef.current++
      const userText = body.greeting ? null : (body.message ?? '')
      const turnStarted = performance.now()
      setTurns((prev) => [
        ...prev,
        {
          id: pendingId,
          user: userText,
          assistant: null,
          pendingText: '',
          analysisState: null,
        },
      ])

      const history = turnsRef.current
        .filter((t) => t.assistant !== null)
        .flatMap((t) => {
          const items: { role: string; content: string }[] = []
          if (t.user) items.push({ role: 'user', content: t.user })
          items.push({ role: 'assistant', content: t.assistant!.reply })
          return items
        })
        .slice(-30)
      logInfo('[guided] sending history of', history.length, 'turns')

      let deltaCount = 0
      const updatePending = (fn: (t: Turn) => Turn) =>
        setTurns((prev) => prev.map((t) => (t.id === pendingId ? fn(t) : t)))

      try {
        const channel = new Channel<GuidedEvent>()
        channel.onmessage = (event) => {
          switch (event.type) {
            case 'reply_delta':
              deltaCount++
              updatePending((t) => ({ ...t, pendingText: t.pendingText + event.text }))
              break
            case 'reply_done':
              // Composer unlocks here — analysis continues in the background.
              logInfo(
                `[guided] reply done in ${(performance.now() - turnStarted).toFixed(0)}ms` +
                  ` (${deltaCount} deltas, ${event.reply.length} chars)`
              )
              updatePending((t) => ({
                ...t,
                assistant: {
                  reply: event.reply,
                  translation: null,
                  tokens: [],
                  features: [],
                  mechanics: [],
                  scaffolds: { replies: [], frames: [], starters: [] },
                },
                analysisState: 'pending',
                pendingText: '',
              }))
              setSending(false)
              // New turns auto-advance the breakdown (Habla spec §7.2);
              // tapping a bubble still re-pins until the next turn.
              setPinnedId(pendingId)
              break
            case 'analysis_done':
              logInfo(
                `[guided] analysis arrived in ${(performance.now() - turnStarted).toFixed(0)}ms:`,
                {
                  tokens: event.turn.tokens.length,
                  mechanics: event.turn.mechanics.length,
                  scaffolds: `${event.turn.scaffolds.replies.length}/${event.turn.scaffolds.frames.length}/${event.turn.scaffolds.starters.length}`,
                }
              )
              updatePending((t) => ({
                ...t,
                assistant: event.turn,
                analysisState: 'done',
              }))
              break
            case 'analysis_failed':
              logWarn('[guided] analysis failed (reply-only turn):', event.error)
              // Clear stale scaffolds so the chips never show suggestions
              // from an older turn after this one failed.
              updatePending((t) => ({
                ...t,
                analysisState: 'failed',
                assistant: t.assistant
                  ? {
                      ...t.assistant,
                      scaffolds: { replies: [], frames: [], starters: [] },
                    }
                  : t.assistant,
              }))
              break
            case 'plan_updated':
              logInfo('[guided] plan updated:', {
                focus: event.plan.session_focus,
                errors: event.plan.recurring_errors.length,
              })
              setPlan(event.plan)
              setProfile(event.profile)
              break
          }
        }
        await invoke<string>('guided_turn', {
          message: body.message ?? '',
          history,
          assistLevel: assist,
          greeting: body.greeting ?? false,
          onEvent: channel,
        })
        // Command resolved = reply pass done (fallback if the event raced).
        setSending(false)
        updatePending((t) =>
          t.assistant
            ? t
            : {
                ...t,
                assistant: {
                  reply: t.pendingText,
                  translation: null,
                  tokens: [],
                  features: [],
                  mechanics: [],
                  scaffolds: { replies: [], frames: [], starters: [] },
                },
                analysisState: 'pending',
                pendingText: '',
              }
        )
      } catch (e) {
        logError('[guided] turn failed:', e)
        setTurns((prev) => prev.filter((t) => t.id !== pendingId))
        setError(String(e).replace(/^Error:\s*/, ''))
        setSending(false)
      }
    },
    [assist]
  )

  useEffect(() => {
    if (!isTauri || greetedRef.current) return
    greetedRef.current = true
    logInfo('[guided] firing greeting turn')
    void requestTurn({ greeting: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauri])

  function updateAssist(level: AssistLevel) {
    setAssist(level)
    localStorage.setItem(ASSIST_STORAGE_KEY, String(level))
  }

  async function send(text: string) {
    const message = text.trim()
    if (!message || sending) return
    setInput('')
    await requestTurn({ message })
  }

  async function toggleMic() {
    if (recording) {
      logInfo('[mic] stop requested by user')
      recorderRef.current?.stop()
      return
    }
    try {
      const constraints: MediaTrackConstraints = {}
      const deviceId = settings?.microphone_device_id
      if (deviceId) {
        constraints.deviceId = { exact: deviceId }
      }
      logInfo('[mic] requesting permission…', { deviceId: deviceId ?? '(default)' })
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      const track = stream.getAudioTracks()[0]
      logInfo('[mic] permission granted, device:', track.label)
      setRecording(true)
      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => {
        logDebug('[mic] chunk:', e.data.size, 'bytes')
        chunks.push(e.data)
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        recorderRef.current = null
        setRecording(false)
        const blob = new Blob(chunks, { type: recorder.mimeType })
        logInfo('[mic] recording finished:', blob.size, 'bytes,', recorder.mimeType)
        const buffer = await blob.arrayBuffer()
        let binary = ''
        const bytes = new Uint8Array(buffer)
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        try {
          const text = await transcribeAudio(btoa(binary))
          logInfo('[mic] transcribed:', text)
          if (text) setInput((prev) => (prev ? `${prev} ${text}` : text))
          else logWarn('[mic] transcription was empty (silence?)')
        } catch (e) {
          logError('[mic] transcription failed:', e)
          setError(String(e).replace(/^Error:\s*/, ''))
        }
      }
      recorder.start()
      logInfo('[mic] recording started (auto-stop in 10s, click again to stop early)')
      setTimeout(() => {
        if (recorder.state !== 'inactive') {
          logInfo('[mic] auto-stopping after 10s')
          recorder.stop()
        }
      }, 10000)
    } catch (e) {
      setRecording(false)
      logError('[mic] failed to start recording:', e)
      setError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const latestAssistantId = [...turns].reverse().find((t) => t.assistant)?.id ?? null
  const pinnedTurn =
    turns.find((t) => t.id === (pinnedId ?? latestAssistantId) && t.assistant) ?? null
  const latestScaffolds: Scaffolds | undefined = [...turns]
    .reverse()
    .find((t) => t.assistant && t.analysisState === 'done')?.assistant?.scaffolds

  const targetLanguageName = settings
    ? (settings.target_language === 'es-ES'
        ? 'Spanish'
        : settings.target_language === 'fr-FR'
          ? 'French'
          : settings.target_language.split('-')[0].toUpperCase())
    : ''

  return (
    <div className="split">
      {/* ── Chat half (paper) ─────────────────────────────────────────── */}
      <section className="chat">
        <div className="chat-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Conversation · {targetLanguageName}</span>
          <button
            type="button"
            className="plan-toggle"
            onClick={() => setPlanOpen(true)}
            title="Teaching plan & profile"
          >
            Plan {plan?.session_focus.length ? `· ${plan.session_focus.length}` : ''}
          </button>
        </div>
        <div className="stream" ref={streamRef}>
          {turns.length === 0 && !error && !sending && (
            <p className="center-note" style={{ color: 'var(--ink-mut)', background: 'none', border: 'none' }}>
              Say hello to start the conversation.
            </p>
          )}
          {turns.map((turn) => (
            <div key={turn.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {turn.user && (
                <div className="msg me">{turn.user}</div>
              )}
              {turn.assistant && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setPinnedId(turn.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setPinnedId(turn.id)
                  }}
                  className={`msg bot ${
                    (pinnedId ?? latestAssistantId) === turn.id ? 'focused' : ''
                  }`}
                >
                  {turn.assistant.tokens.length > 0 ? (
                    <span className="line">
                      {turn.assistant.tokens.map((tok, i) => (
                        <span key={i} className="wu">
                          <span className={`w ${tok.notable ? 'notice' : ''}`}>
                            {tok.text}
                          </span>
                          {assist >= 2 && tok.gloss && (
                            <span className="wg">{tok.gloss}</span>
                          )}
                        </span>
                      ))}
                    </span>
                  ) : (
                    turn.assistant.reply
                  )}
                  {assist >= 3 && turn.assistant.translation && (
                    <div className="trans">{turn.assistant.translation}</div>
                  )}
                </div>
              )}
              {turn.assistant === null && (
                <div className="msg bot pending">{turn.pendingText || '…'}</div>
              )}
            </div>
          ))}
          {error && <div className="err">{error}</div>}
        </div>

        {/* Assist slider */}
        <div className="assistbar">
          <div className="assist-row">
            <span className="assist-label">Assist</span>
            <input
              type="range"
              min={0}
              max={3}
              step={1}
              value={assist}
              onChange={(e) => updateAssist(Number(e.target.value) as AssistLevel)}
              className="assist-range"
              aria-label="Assist level"
            />
            <span className="assist-state">{ASSIST_LABELS[assist]}</span>
          </div>
          <div className="assist-hint">{ASSIST_HINTS[assist]}</div>
        </div>

        {/* Composer */}
        <div className="composer">
          <div className="scaffolds">
            {assist === 3 &&
              latestScaffolds?.replies.map((reply) => (
                <button
                  key={reply}
                  type="button"
                  className="scaf"
                  onClick={() => void send(reply)}
                >
                  {reply}
                </button>
              ))}
            {assist === 2 &&
              latestScaffolds?.frames.map((frame) => (
                <button
                  key={frame}
                  type="button"
                  className="scaf"
                  onClick={() => setInput(frame)}
                >
                  {frame}
                </button>
              ))}
            {assist === 1 &&
              latestScaffolds?.starters.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  className="scaf"
                  onClick={() => setInput(`${starter} `)}
                >
                  {starter}
                </button>
              ))}
          </div>
          <form
            className="crow"
            onSubmit={(e) => {
              e.preventDefault()
              void send(input)
            }}
          >
            <input
              className="field"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={targetLanguageName ? `Write in ${targetLanguageName}…` : 'Write…'}
              disabled={!isTauri}
            />
            <button
              type="button"
              className={`mic ${recording ? 'recording' : ''}`}
              onClick={() => void toggleMic()}
              disabled={!isTauri || sending}
              title={recording ? 'Stop recording' : 'Record audio'}
              aria-label={recording ? 'Stop recording' : 'Record audio'}
            >
              ●
            </button>
            <button
              type="submit"
              className="send"
              disabled={sending || !input.trim()}
              aria-label="Send"
            >
              ↑
            </button>
          </form>
        </div>
      </section>

      {/* ── Breakdown half (dark) ─────────────────────────────────────── */}
      <section className="break">
        <div className="break-head">
          <span className="k">Breakdown · latest turn</span>
          <span className="live">● live</span>
        </div>
        <div className="focus-strip">
          {plan && plan.session_focus.length > 0 ? (
            plan.session_focus.map((focus) => (
              <span key={focus} className="focus-chip">
                {focus}
              </span>
            ))
          ) : (
            <span className="focus-chip muted">Warming up — keep chatting and this fills in</span>
          )}
        </div>
        <div className="break-scroll">
          {pinnedTurn?.assistant ? (
            <div>
              {pinnedTurn.analysisState === 'pending' && (
                <p className="sect-k" style={{ color: 'var(--steel)', marginBottom: 12 }}>
                  ⟳ Analyzing grammar…
                </p>
              )}
              <p className="sentence">
                {pinnedTurn.assistant.tokens.length > 0
                  ? pinnedTurn.assistant.tokens.map((tok, i) => {
                      const prev =
                        i > 0 ? pinnedTurn.assistant!.tokens[i - 1].text : ''
                      return (
                        <span key={i}>
                          {i > 0 && needsSpaceBetween(prev, tok.text) ? ' ' : ''}
                          <span className={tok.notable ? 'hl' : ''}>{tok.text}</span>
                        </span>
                      )
                    })
                  : pinnedTurn.assistant.reply}
              </p>

              {pinnedTurn.assistant.translation && assist < 3 && (
                <p className="trans-d">{pinnedTurn.assistant.translation}</p>
              )}

              {pinnedTurn.assistant.tokens.length > 0 && (
                <>
                  <p className="sect-k">Word by word</p>
                  <div className="gloss">
                    {pinnedTurn.assistant.tokens.map((tok, i) => (
                      <div
                        key={i}
                        className={`tok ${tok.notable ? 'key' : ''}`}
                      >
                        <span className="sp">{tok.text}</span>
                        {tok.gloss && <span className="gl">{tok.gloss}</span>}
                        {tok.pos && <span className="po">{tok.pos}</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {pinnedTurn.assistant.features.length > 0 && (
                <>
                  <p className="sect-k">Grammar spotted</p>
                  <div className="feats">
                    {pinnedTurn.assistant.features.map((feat) => {
                      const [key, value] = feat.split('=')
                      return (
                        <span key={feat} className="feat">
                          {key}=<b>{value ?? ''}</b>
                        </span>
                      )
                    })}
                  </div>
                </>
              )}

              {pinnedTurn.assistant.mechanics.length > 0 && (
                <>
                  <p className="sect-k">What&apos;s happening</p>
                  {pinnedTurn.assistant.mechanics.map((mech) => (
                    <div key={mech.title} className="exp">
                      <div className="exp-top">
                        <span className="exp-title">{mech.title}</span>
                        {mech.cefr && <span className="exp-cefr">{mech.cefr}</span>}
                      </div>
                      <p className="exp-body">{mech.body}</p>
                      {mech.example && <p className="exp-ex">{mech.example}</p>}
                      {mech.contrast && (
                        <p className="exp-vs">
                          <span>vs English</span>
                          {mech.contrast}
                        </p>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : (
            <p className="center-note">The breakdown of the tutor&apos;s latest reply lands here.</p>
          )}
        </div>
      </section>

      {/* ── Plan & Profile drawer (fully observable) ──────────────────── */}
      {planOpen && (
        <div className="plan-backdrop" onClick={() => setPlanOpen(false)}>
          <div className="plan-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="plan-head">
              <span className="k">Teaching plan · profile</span>
              <button type="button" className="popup-x" onClick={() => setPlanOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="plan-body">
              {plan && (
                <>
                  <p className="sect-k">Session focus</p>
                  {plan.session_focus.length > 0 ? (
                    <div className="feats">
                      {plan.session_focus.map((f) => (
                        <span key={f} className="feat">
                          {f}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="plan-muted">Warming up — keep chatting and this fills in.</p>
                  )}

                  <p className="sect-k">Recast queue (correction budget: {plan.correction_budget}/reply)</p>
                  {plan.recurring_errors.length > 0 ? (
                    <ul className="plan-list">
                      {plan.recurring_errors.map((e, i) => (
                        <li key={i}>
                          <s>{e.error}</s> → <b>{e.correction}</b> <span className="plan-dim">×{e.seen_count}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="plan-muted">No recurring errors yet.</p>
                  )}

                  {plan.vocab_recycle.length > 0 && (
                    <>
                      <p className="sect-k">Vocabulary to recycle</p>
                      <div className="feats">
                        {plan.vocab_recycle.map((v) => (
                          <span key={v} className="feat">
                            {v}
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {plan.avoid.length > 0 && (
                    <>
                      <p className="sect-k">Avoid (overload guard)</p>
                      <div className="feats">
                        {plan.avoid.map((a) => (
                          <span key={a} className="feat">
                            {a}
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {plan.energy_read && (
                    <>
                      <p className="sect-k">Learner energy</p>
                      <p className="plan-line">{plan.energy_read}</p>
                    </>
                  )}

                  {plan.taught_ledger.length > 0 && (
                    <>
                      <p className="sect-k">Taught so far</p>
                      <ul className="plan-list">
                        {plan.taught_ledger.map((t, i) => (
                          <li key={i}>
                            {t.mechanic} <span className="plan-dim">(turn {t.last_seen_turn})</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}

              {profile && (
                <>
                  <p className="sect-k" style={{ marginTop: 26 }}>
                    Profile · {profile.sessions} session{profile.sessions === 1 ? '' : 's'}
                  </p>
                  {profile.about && <p className="plan-line">{profile.about}</p>}
                  {profile.level_notes && (
                    <>
                      <p className="sect-k">Level read</p>
                      <p className="plan-line">{profile.level_notes}</p>
                    </>
                  )}
                  {profile.strengths.length > 0 && (
                    <>
                      <p className="sect-k">Strengths</p>
                      <div className="feats">
                        {profile.strengths.map((s) => (
                          <span key={s} className="feat">
                            {s}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  {profile.weaknesses.length > 0 && (
                    <>
                      <p className="sect-k">Working on</p>
                      <div className="feats">
                        {profile.weaknesses.map((w) => (
                          <span key={w} className="feat">
                            {w}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  {profile.interests.length > 0 && (
                    <>
                      <p className="sect-k">Interests</p>
                      <div className="feats">
                        {profile.interests.map((s) => (
                          <span key={s} className="feat">
                            {s}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  {profile.long_term_errors.length > 0 && (
                    <>
                      <p className="sect-k">Long-term errors</p>
                      <ul className="plan-list">
                        {profile.long_term_errors.map((e, i) => (
                          <li key={i}>
                            <s>{e.error}</s> → <b>{e.correction}</b> <span className="plan-dim">×{e.seen_count}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
              {plan && (
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setPlan(null)
                      setProfile(null)
                      void getPlan()
                        .then((docs) => {
                          setPlan(docs.plan)
                          setProfile(docs.profile)
                          logInfo('[guided] plan refreshed')
                        })
                        .catch((e) => logError('[guided] plan refresh failed:', e))
                    }}
                  >
                    ↻ Refresh
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
