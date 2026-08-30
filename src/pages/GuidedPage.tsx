import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  AssistLevel,
  CoachFeedback,
  GuidedEvent,
  GuidedToken,
  GuidedTurnResult,
  Profile,
  Settings,
  Scaffolds,
  TeachingPlan,
} from '../types'
import { GlossPopup, popupAnchor, type PopupState } from '../components/GlossPopup'
import { getPlan, getSettings, isTauri, TARGET_LANGUAGES, transcribeAudio } from '../lib/tauri'
import { openOverlay } from '../lib/back'
import { loadVoices, speak, speechSupported, stopSpeaking } from '../lib/speech'
import { comboFromEvent } from '../lib/keyboard'
import { groupSentences, splitSentences } from '../lib/sentences'
import { normalizeDocs } from '../lib/normalize'
import { WaveformStrip } from '../components/WaveformStrip'
import { logDebug, logError, logInfo, logWarn } from '../lib/log'
import { needsSpaceBetween } from '../lib/token-spacing'

interface Turn {
  id: number
  user: string | null
  assistant: GuidedTurnResult | null
  pendingText: string
  analysisState: 'pending' | 'done' | 'failed' | null
  coach?: CoachFeedback
  coachError?: string
}

const ASSIST_STORAGE_KEY = 'glossa_assist'
const BREAK_STORAGE_KEY = 'glossa_break'
const FOCUS_STORAGE_KEY = 'glossa_focus'
const MOBILE_QUERY = '(max-width: 860px)'
const MIC_SILENCE_STOP_MS = 20_000
const MIC_VOICE_THRESHOLD = 0.02

// Conversation steering: level feeds the CEFR in every prompt; topic steers
// the conversation when natural. Persisted per device.
const STEER_LEVELS = [
  { value: 'beginner', label: 'Beginner', cefr: 'A2' },
  { value: 'intermediate', label: 'Intermediate', cefr: 'B1' },
  { value: 'advanced', label: 'Advanced', cefr: 'C1' },
]
const STEER_TOPICS = [
  'Daily routines', 'Food & cooking', 'Travel stories', 'Work & studies',
  'Family & friends', 'Music & hobbies', 'Movies & series', 'Weekend plans',
  'Childhood memories', 'Weather & seasons', 'Sports & exercise', 'Technology',
  'Pets & animals', 'Hometown', 'Dreams & goals', 'Shopping & markets',
]
const ASSIST_LABELS: Record<AssistLevel, string> = {
  0: 'Immersion',
  1: 'Light',
  2: 'Guided',
  3: 'Full support',
}
const ASSIST_HINTS: Record<AssistLevel, string> = {
  0: 'Only the language you are learning. Tap a word for its meaning, punctuation for the sentence.',
  1: 'Key words are underlined. Tap any word for its meaning — starters help you get going.',
  2: 'Every word has its meaning underneath. Tap punctuation to reveal a sentence.',
  3: 'Full translation shown. Tap a whole reply to send it — hold a conversation before you can build one.',
}

// Module-scoped so remounts (HMR, tab switches) can never re-fire the
// greeting pipeline — each greeting is 6 AI calls.
let sessionGreeted = false

/// A turn whose reply is known but analysis hasn't landed yet.
function emptyAssistant(reply: string): GuidedTurnResult {
  return {
    reply,
    translation: null,
    tokens: [],
    mechanics: [],
    scaffolds: { replies: [], frames: [], starters: [] },
    errors: [],
  }
}

interface TurnViewProps {
  turn: Turn
  focused: boolean
  ttsReady: boolean
  assist: AssistLevel
  onBubbleTap: (id: number) => void
  onSpeak: (text: string) => void
  onPopup: React.Dispatch<React.SetStateAction<PopupState | null>>
}

/// Memoized: during streaming, every delta re-renders only the turn that
/// changed — not the whole conversation.
const TurnView = memo(function TurnView({
  turn,
  focused,
  ttsReady,
  assist,
  onBubbleTap,
  onSpeak,
  onPopup,
}: TurnViewProps) {
  const assistant = turn.assistant
  const sentences = useMemo(
    () => (assistant && assistant.tokens.length > 0 ? groupSentences(assistant.tokens) : []),
    [assistant]
  )
  const tapToken = (
    tok: GuidedToken,
    si: number,
    e: React.MouseEvent<HTMLSpanElement>
  ) => {
    if (!assistant) return
    const pos = popupAnchor(e.currentTarget)
    const show = (text: string) =>
      onPopup((prev) => (prev && prev.text === text ? null : { text, ...pos }))
    if (tok.gloss) {
      // Below Guided level, glosses are not rendered inline — tap to see one.
      if (assist < 2) show(tok.gloss)
      return
    }
    // Gloss-less (punctuation) token: reveal that sentence's translation.
    if (assist >= 3 || !assistant.translation) return
    const parts = splitSentences(assistant.translation)
    show(
      parts.length === sentences.length
        ? parts[si] ?? assistant.translation
        : assistant.translation
    )
  }
  const bubbleTap = () => {
    // Pin this turn AND surface its analysis — on mobile the panel is
    // usually collapsed, so a tap should reveal it.
    onBubbleTap(turn.id)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {turn.user && <div className="msg me">{turn.user}</div>}
      {assistant && (
        <div
          role="button"
          tabIndex={0}
          onClick={bubbleTap}
          onKeyDown={(e) => {
            if (e.key === 'Enter') bubbleTap()
          }}
          className={`msg bot ${focused ? 'focused' : ''}${ttsReady ? ' with-speak' : ''}`}
        >
          {assistant.tokens.length > 0 ? (
            <span className="line">
              {sentences.flatMap((sentence, si) =>
                sentence.map((tok, ti) => {
                  const canGloss = !!tok.gloss && assist < 2
                  const canReveal = !tok.gloss && !!assistant.translation && assist < 3
                  const tappable = canGloss || canReveal
                  return (
                    <span key={`${si}-${ti}`} className="wu">
                      <span
                        className={`w ${tok.notable ? 'notice' : ''}${tappable ? ' tap' : ''}`}
                        data-gloss-trigger={tappable || undefined}
                        onClick={tappable ? (e) => tapToken(tok, si, e) : undefined}
                      >
                        {tok.text}
                      </span>
                      {assist >= 2 && tok.gloss && <span className="wg">{tok.gloss}</span>}
                    </span>
                  )
                })
              )}
            </span>
          ) : (
            assistant.reply
          )}
          {assist >= 3 && assistant.translation && (
            <div className="trans">{assistant.translation}</div>
          )}
          {ttsReady && (
            <button
              type="button"
              className="speak-btn"
              title="Speak reply"
              aria-label="Speak reply"
              onClick={(e) => {
                e.stopPropagation()
                onSpeak(assistant.reply)
              }}
            >
              🔊
            </button>
          )}
        </div>
      )}
      {assistant === null && (
        <div className="msg bot pending">{turn.pendingText || '…'}</div>
      )}
    </div>
  )
})

/// Sidebar tutor: latest learner message's coaching. Per-message
/// auto-feedback; the interactive coach thread is a planned bite.
function CoachFeed({ turns }: { turns: Turn[] }) {
  const latest = [...turns]
    .reverse()
    .find((t) => t.user !== null && (t.coach || t.coachError))

  if (!latest) {
    return (
      <div className="break-scroll coach-feed">
        <p className="center-note">
          Say something in Spanish — your coach will weigh in here.
        </p>
      </div>
    )
  }
  if (latest.coachError) {
    return (
      <div className="break-scroll coach-feed">
        <div className="turn-errors">⚠ {latest.coachError}</div>
      </div>
    )
  }
  const c = latest.coach
  if (!c) {
    return (
      <div className="break-scroll coach-feed">
        <p className="center-note">⟳ Coach is listening…</p>
      </div>
    )
  }
  return (
    <div className="break-scroll coach-feed">
      <div className="coach-card">
        <div className="coach-scores">
          <ScoreMeter label="Understood" value={c.comprehensibility} />
          <ScoreMeter label="Grammar" value={c.grammar} />
        </div>
        <p className="coach-remark">{c.remark}</p>
        {(c.used_target.length > 0 || c.used_native.length > 0) && (
          <div className="coach-split">
            {c.used_target.length > 0 && (
              <div className="split-row">
                <span className="split-k target">ES</span>
                <span>{c.used_target.join(' · ')}</span>
              </div>
            )}
            {c.used_native.length > 0 && (
              <div className="split-row">
                <span className="split-k native">EN</span>
                <span>{c.used_native.join(' · ')}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {c.corrections.length > 0 && (
        <p className="sect-k" style={{ marginTop: 14 }}>
          Corrections
        </p>
      )}
      {c.corrections.map((cor, i) => (
        <div key={i} className="coach-correction">
          <div className="cor-line">
            <s>{cor.said}</s> <span className="cor-arrow">→</span>{' '}
            <b>{cor.corrected}</b> <span className="cor-kind">{cor.kind}</span>
          </div>
          <p className="cor-why">{cor.explanation}</p>
        </div>
      ))}
    </div>
  )
}

function ScoreMeter({ label, value }: { label: string; value: number }) {
  return (
    <div className="score-meter">
      <span className="score-label">{label}</span>
      <span className="score-dots">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={n <= value ? 'dot on' : 'dot'}>
            ●
          </span>
        ))}
      </span>
      <span className="score-num">{value}/5</span>
    </div>
  )
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
  // Analysis panel: open by default on desktop, collapsed on narrow/mobile
  // screens so the chat owns the view; the choice persists.
  const [breakOpen, setBreakOpen] = useState<boolean>(() => {
    const stored = localStorage.getItem(BREAK_STORAGE_KEY)
    if (stored === 'open') return true
    if (stored === 'closed') return false
    return !window.matchMedia(MOBILE_QUERY).matches
  })
  const toggleBreak = useCallback(() => {
    setBreakOpen((open) => {
      localStorage.setItem(BREAK_STORAGE_KEY, open ? 'closed' : 'open')
      return !open
    })
  }, [])
  const openBreak = useCallback(() => {
    setBreakOpen(true)
    localStorage.setItem(BREAK_STORAGE_KEY, 'open')
  }, [])
  const onBubbleTap = useCallback(
    (id: number) => {
      setPinnedId(id)
      if (!breakOpen) openBreak()
    },
    [breakOpen, openBreak]
  )
  // Session-focus chips: collapsed by default — the tutor's steering notes
  // are context, not the thing you opened the breakdown to read.
  const [focusOpen, setFocusOpen] = useState<boolean>(() => {
    return localStorage.getItem(FOCUS_STORAGE_KEY) === 'open'
  })
  const [coachTab, setCoachTab] = useState<'coach' | 'analysis'>('coach')
  const [steerLevel, setSteerLevel] = useState<string>(
    () => localStorage.getItem('glossa_level') ?? 'beginner'
  )
  const [steerTopic, setSteerTopic] = useState<string>(
    () => localStorage.getItem('glossa_topic') ?? ''
  )
  const toggleFocus = useCallback(() => {
    setFocusOpen((open) => {
      localStorage.setItem(FOCUS_STORAGE_KEY, open ? 'closed' : 'open')
      return !open
    })
  }, [])
  const [wordPopup, setWordPopup] = useState<PopupState | null>(null)
  const closePopup = useCallback(() => setWordPopup(null), [])
  // Android back button closes the popup instead of exiting the app.
  useEffect(
    () => (wordPopup ? openOverlay(closePopup) : undefined),
    [wordPopup, closePopup]
  )
  useEffect(
    () => (planOpen ? openOverlay(() => setPlanOpen(false)) : undefined),
    [planOpen]
  )
  const [ttsReady, setTtsReady] = useState(speechSupported())
  const autoSpeak = settings?.auto_speak ?? false

  const speakReply = useCallback(
    (text: string) => {
      const lang = settings?.target_language ?? 'es-ES'
      if (!speak(text, lang)) logWarn('[tts] speech unavailable or empty text')
    },
    [settings?.target_language]
  )

  const streamRef = useRef<HTMLDivElement | null>(null)
  const greetedRef = useRef(false)
  const nextIdRef = useRef(1)
  const turnsRef = useRef<Turn[]>([])
  turnsRef.current = turns
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const silencePollRef = useRef<number | null>(null)
  const [recAnalyser, setRecAnalyser] = useState<AnalyserNode | null>(null)

  // Latest-identity refs so async callbacks (recorder.onstop, key handlers)
  // always route through the current closures instead of stale ones.
  const settingsRef = useRef<Settings | null>(null)
  settingsRef.current = settings
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {})
  const toggleMicRef = useRef<() => void>(() => {})
  const toggleBreakRef = useRef<() => void>(() => {})

  useEffect(() => {
    logInfo('[guided] page mounted, isTauri =', isTauri)
    // Preload OS speech voices so the 🔊 buttons work on first tap.
    void loadVoices().then((v) => {
      setTtsReady(v.length > 0 || speechSupported())
      if (!v.length) logWarn('[tts] no OS voices found — speech disabled')
    })
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
        const norm = normalizeDocs(docs.plan, docs.profile)
        setPlan(norm.plan)
        setProfile(norm.profile)
        logInfo('[guided] plan loaded:', {
          focus: docs.plan.session_focus,
          errors: docs.plan.recurring_errors.length,
        })
      })
      .catch((e) => logWarn('[guided] plan load failed:', e))
  }, [])

  useEffect(() => {
    const el = streamRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      logDebug(
        '[layout] win', window.innerWidth,
        'doc', document.documentElement.scrollWidth,
        'stream client', el.clientWidth,
        'stream scroll', el.scrollWidth
      )
    }
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
              if (autoSpeak) speakReply(event.reply)
              updatePending((t) => ({
                ...t,
                assistant: emptyAssistant(event.reply),
                analysisState: 'pending',
                pendingText: '',
              }))
              setSending(false)
              // New turns auto-advance the breakdown (Habla spec §7.2);
              // tapping a bubble still re-pins until the next turn.
              setPinnedId(pendingId)
              break
            case 'analysis_section':
              // Progressive hydration: merge whichever section just landed;
              // the slowest call never gates the ones that finished first.
              updatePending((t) =>
                t.assistant
                  ? {
                      ...t,
                      assistant: {
                        ...t.assistant,
                        tokens: event.tokens ?? t.assistant.tokens,
                        translation: event.translation ?? t.assistant.translation,
                        mechanics: event.mechanics ?? t.assistant.mechanics,
                        scaffolds: event.scaffolds ?? t.assistant.scaffolds,
                      },
                    }
                  : t
              )
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
              // The failed turn holds no scaffolds of its own; the chips
              // fall back to the newest turn that has them (best available).
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
            case 'coach_done':
              logInfo(
                '[coach] feedback:', event.feedback.corrections.length, 'corrections,',
                'comp', event.feedback.comprehensibility, '/ grammar', event.feedback.grammar
              )
              updatePending((t) => ({ ...t, coach: event.feedback }))
              break
            case 'coach_failed':
              logWarn('[coach] failed:', event.error)
              updatePending((t) => ({ ...t, coachError: event.error }))
              break
            case 'plan_updated':
              logInfo('[guided] plan updated:', {
                focus: event.plan.session_focus,
                errors: event.plan.recurring_errors.length,
              })
              const norm = normalizeDocs(event.plan, event.profile)
              setPlan(norm.plan)
              setProfile(norm.profile)
              break
          }
        }
        await invoke<string>('guided_turn', {
          message: body.message ?? '',
          history,
          assistLevel: assist,
          greeting: body.greeting ?? false,
          level: steerLevel,
          topic: steerTopic || null,
          onEvent: channel,
        })
        // Command resolved = reply pass done (fallback if the event raced).
        setSending(false)
        updatePending((t) =>
          t.assistant
            ? t
            : {
                ...t,
                assistant: emptyAssistant(t.pendingText),
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
    [assist, autoSpeak, speakReply, steerLevel, steerTopic]
  )

  // Diagnostic: keyboard/viewport resize tracking. If the IME is handled
  // correctly, visualViewport.height shrinks when the keyboard opens.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const report = () =>
      logDebug(
        '[viewport] vv.height', Math.round(vv.height),
        'offsetTop', Math.round(vv.offsetTop),
        'innerHeight', window.innerHeight
      )
    report()
    vv.addEventListener('resize', report)
    vv.addEventListener('scroll', report)
    return () => {
      vv.removeEventListener('resize', report)
      vv.removeEventListener('scroll', report)
    }
  }, [])

  useEffect(() => {
    if (!isTauri || greetedRef.current || sessionGreeted) return
    greetedRef.current = true
    sessionGreeted = true
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
    stopSpeaking() // new turn: silence any ongoing playback
    await requestTurn({ message })
  }
  sendRef.current = send
  toggleMicRef.current = toggleMic
  toggleBreakRef.current = toggleBreak

  async function toggleMic() {
    if (recording) {
      logInfo('[mic] stop requested by user')
      recorderRef.current?.stop()
      return
    }
    stopSpeaking() // never record over playback
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
        setRecAnalyser(null)
        // Tear down the silence detector.
        if (silencePollRef.current !== null) {
          window.clearInterval(silencePollRef.current)
          silencePollRef.current = null
        }
        void audioCtxRef.current?.close()
        audioCtxRef.current = null
        const blob = new Blob(chunks, { type: recorder.mimeType })
        logInfo('[mic] recording finished:', blob.size, 'bytes,', recorder.mimeType)
        const buffer = await blob.arrayBuffer()
        // Diagnostic: peak amplitude of the capture. Whisper hallucinates a
        // fixed phrase on silence — this tells us instantly whether the
        // emulator is delivering real audio or dead air.
        try {
          const probe = new AudioContext()
          const decoded = await probe.decodeAudioData(buffer.slice(0))
          let peak = 0
          for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
            const data = decoded.getChannelData(ch)
            for (let i = 0; i < data.length; i++) {
              const a = Math.abs(data[i])
              if (a > peak) peak = a
            }
          }
          void probe.close()
          logDebug(
            '[mic] peak amplitude:', peak.toFixed(4),
            peak < 0.01 ? '=> SILENCE (host audio not reaching emulator)' : '=> real audio captured'
          )
        } catch (e) {
          logWarn('[mic] amplitude probe failed:', e)
        }
        let binary = ''
        const bytes = new Uint8Array(buffer)
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        try {
          const text = await transcribeAudio(btoa(binary))
          logInfo('[mic] transcribed:', text)
          if (text) {
            if (settingsRef.current?.auto_send) {
              logInfo('[mic] auto-send enabled — sending transcription')
              void sendRef.current(text)
            } else {
              setInput((prev) => (prev ? `${prev} ${text}` : text))
            }
          } else logWarn('[mic] transcription was empty (silence?)')
        } catch (e) {
          logError('[mic] transcription failed:', e)
          setError(String(e).replace(/^Error:\s*/, ''))
        }
      }
      recorder.start()
      logInfo('[mic] recording started (tap again to stop; auto-stops after 20s of silence)')

      // Silence auto-stop: reset a 20s timer whenever the mic picks up voice,
      // stop when the timer expires. Talking continuously keeps it rolling.
      // The same analyser feeds the live waveform strip (2048 = full detail).
      try {
        const ctx = new AudioContext()
        void ctx.resume()
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        source.connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        audioCtxRef.current = ctx
        setRecAnalyser(analyser)
        let lastVoiceAt = Date.now()
        silencePollRef.current = window.setInterval(() => {
          analyser.getFloatTimeDomainData(buf)
          let peak = 0
          for (let i = 0; i < buf.length; i++) {
            const a = Math.abs(buf[i])
            if (a > peak) peak = a
          }
          const now = Date.now()
          if (peak >= MIC_VOICE_THRESHOLD) {
            lastVoiceAt = now
          } else if (
            recorder.state !== 'inactive' &&
            now - lastVoiceAt >= MIC_SILENCE_STOP_MS
          ) {
            logInfo('[mic] silence auto-stop (20s without voice)')
            recorder.stop()
          }
        }, 500)
      } catch (e) {
        logWarn('[mic] silence detection unavailable — manual stop only:', e)
      }
    } catch (e) {
      setRecording(false)
      logError('[mic] failed to start recording:', e)
      setError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  // Configurable keyboard shortcuts. Modifier combos work while typing;
  // the handler ignores repeat events and the shortcut-capture inputs.
  useEffect(() => {
    const shortcuts = settings?.shortcuts
    if (!shortcuts) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[data-shortcut-capture]')) return
      const combo = comboFromEvent(e)
      const inField = /^(input|textarea|select)$/i.test(target?.tagName ?? '')
      const hasMod = e.ctrlKey || e.altKey || e.metaKey
      if (!hasMod && inField) return
      if (combo === shortcuts.mic) {
        e.preventDefault()
        toggleMicRef.current()
      } else if (combo === shortcuts.speak) {
        e.preventDefault()
        const last = [...turnsRef.current].reverse().find((t) => t.assistant)
        if (last?.assistant) speakReply(last.assistant.reply)
      } else if (combo === shortcuts.panel) {
        e.preventDefault()
        toggleBreakRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings?.shortcuts, speakReply])





  const latestAssistantId = [...turns].reverse().find((t) => t.assistant)?.id ?? null
  const pinnedTurn =
    turns.find((t) => t.id === (pinnedId ?? latestAssistantId) && t.assistant) ?? null
  // Best-available scaffolds: the newest turn that has any. While a fresh
  // analysis is still running, the previous turn's scaffolds keep the chips
  // populated instead of leaving the composer empty.
  const latestScaffolds: Scaffolds | undefined = [...turns]
    .reverse()
    .find(
      (t) =>
        t.assistant &&
        (t.assistant.scaffolds.replies.length > 0 ||
          t.assistant.scaffolds.frames.length > 0 ||
          t.assistant.scaffolds.starters.length > 0)
    )?.assistant?.scaffolds

  // Display name from the shared language list — no ad-hoc mapping.
  const targetLanguageName = settings
    ? (TARGET_LANGUAGES.find(([c]) => c === settings.target_language)?.[1] ??
       settings.target_language.split('-')[0].toUpperCase())
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
            <TurnView
              key={turn.id}
              turn={turn}
              focused={(pinnedId ?? latestAssistantId) === turn.id}
              ttsReady={ttsReady}
              assist={assist}
              onBubbleTap={onBubbleTap}
              onSpeak={speakReply}
              onPopup={setWordPopup}
            />
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
          {recording && recAnalyser && (
            <WaveformStrip analyserNode={recAnalyser} height={44} timelineSeconds={6} />
          )}
           <div className="steer-row">
             <select
               className="steer-select"
               value={steerLevel}
               onChange={(e) => {
                 setSteerLevel(e.target.value)
                 localStorage.setItem('glossa_level', e.target.value)
               }}
               aria-label="Learner level"
               title="Learner level — steers every prompt"
             >
               {STEER_LEVELS.map((l) => (
                 <option key={l.value} value={l.value}>
                   {l.label}
                 </option>
               ))}
             </select>
             <select
               className="steer-select topic"
               value={steerTopic}
               onChange={(e) => {
                 setSteerTopic(e.target.value)
                 localStorage.setItem('glossa_topic', e.target.value)
               }}
               aria-label="Conversation topic"
               title="Topic steering — the tutor works the conversation toward this"
             >
               <option value="">Topic: anything</option>
               {STEER_TOPICS.map((tp) => (
                 <option key={tp} value={tp}>
                   {tp}
                 </option>
               ))}
             </select>
             <button
               type="button"
               className="steer-dice"
               title="Random topic"
               aria-label="Random topic"
               onClick={() => {
                 const tp = STEER_TOPICS[Math.floor(Math.random() * STEER_TOPICS.length)]
                 setSteerTopic(tp)
                 localStorage.setItem('glossa_topic', tp)
               }}
             >
               🎲
             </button>
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
              // Keyboard semantics: predictions/spellcheck must match the
              // language being LEARNED, not the device language.
              lang={settings?.target_language ?? 'es-ES'}
              enterKeyHint="send"
              autoCorrect="off"
              spellCheck={false}
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
      <section className={`break ${breakOpen ? '' : 'collapsed'}`}>
        <button
          type="button"
          className="break-head"
          onClick={toggleBreak}
          aria-expanded={breakOpen}
          title={breakOpen ? 'Collapse breakdown' : 'Expand breakdown'}
        >
          <span className="k">Breakdown · latest turn</span>
          <span className="head-right">
            <span className="live">● live</span>
            <span className="chev">{breakOpen ? '▾' : '▸'}</span>
          </span>
        </button>
        <div className="coach-tabs">
          <button
            type="button"
            className={`coach-tab ${coachTab === 'coach' ? 'active' : ''}`}
            onClick={() => setCoachTab('coach')}
          >
            Coach
          </button>
          <button
            type="button"
            className={`coach-tab ${coachTab === 'analysis' ? 'active' : ''}`}
            onClick={() => setCoachTab('analysis')}
          >
            Analysis
          </button>
        </div>
        {coachTab === 'analysis' && (
          <>
            <button
              type="button"
              className="focus-toggle"
              onClick={toggleFocus}
              aria-expanded={focusOpen}
              title={focusOpen ? 'Hide session focus' : 'Show session focus'}
            >
              {focusOpen ? '▾' : '▸'} Session focus
              {!focusOpen && plan && plan.session_focus.length > 0 && ` (${plan.session_focus.length})`}
            </button>
            {focusOpen && (
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
            )}
          </>
        )}
        {coachTab === 'coach' && <CoachFeed turns={turns} />}
        {coachTab === 'analysis' && (
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

          {pinnedTurn.assistant.errors.length > 0 && (
            <div className="turn-errors">
              {pinnedTurn.assistant.errors.map((e, i) => (
                <div key={i}>⚠ {e}</div>
              ))}
            </div>
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
        )}
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
                          const norm = normalizeDocs(docs.plan, docs.profile)
                          setPlan(norm.plan)
                          setProfile(norm.profile)
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

      {wordPopup && <GlossPopup popup={wordPopup} onClose={closePopup} />}
    </div>
  )
}
