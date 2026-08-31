import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import type {
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
import { getPlan, getSettings, isTauri, LANGUAGES, transcribeAudio } from '../lib/tauri'
import { openOverlay } from '../lib/back'
import { loadVoices, speakSmart, speechSupported, stopSpeaking } from '../lib/speech'
import { comboFromEvent } from '../lib/keyboard'
import { groupSentences, splitSentences } from '../lib/sentences'
import { normalizeDocs } from '../lib/normalize'
import { WaveformStrip } from '../components/WaveformStrip'
import { WordInsightModal } from '../components/WordInsightModal'
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

const BREAK_STORAGE_KEY = 'glossa_break'
const SPLIT_STORAGE_KEY = 'glossa_split'
const COACH_COLLAPSED_KEY = 'glossa_coach_collapsed'
const ANALYSIS_COLLAPSED_KEY = 'glossa_analysis_collapsed'
const MIC_SILENCE_STOP_MS = 20_000
const MIC_VOICE_THRESHOLD = 0.02

function ScaffoldRow({
  label,
  items,
  onPick,
}: {
  label: string
  items?: string[]
  onPick: (s: string) => void
}) {
  if (!items || items.length === 0) return null
  return (
    <div className="scaffold-row">
      <span className="scaffold-label">{label}</span>
      <div className="scaffold-chips">
        {items.map((s) => (
          <button key={s} type="button" className="scaf" onClick={() => onPick(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

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

// Module-scoped so remounts (HMR, tab switches) can never re-fire the
// greeting pipeline — each greeting is a stack of AI calls.
let sessionGreeted = false

/// A turn whose reply is known but analysis hasn't landed yet.
function emptyAssistant(reply: string): GuidedTurnResult {
  return {
    reply,
    translation: null,
    tokens: [],
    user_tokens: [],
    user_translation: null,
    mechanics: [],
    scaffolds: { replies: [], frames: [], starters: [] },
    errors: [],
  }
}

interface TurnViewProps {
  turn: Turn
  focused: boolean
  ttsReady: boolean
  revealed: Set<string>
  onReveal: (keys: string[]) => void
  onBubbleTap: (id: number) => void
  onSpeak: (text: string) => void
  onPopup: React.Dispatch<React.SetStateAction<PopupState | null>>
  onInspect: (turnId: number, side: 'me' | 'bot', index: number) => void
  onHold: (word: string, sentence: string) => void
  onToggleReveal: (keys: string[]) => void
}

/// One token entry: the token plus which sentence it belongs to (for
/// punctuation-tap sentence reveal).
interface TokenEntry {
  tok: GuidedToken
  si: number
}

function tokenEntries(tokens: GuidedToken[]): TokenEntry[] {
  return groupSentences(tokens).flatMap((sentence, si) =>
    sentence.map((tok) => ({ tok, si }))
  )
}

/// Shared per-token rendering for BOTH bubbles (learner + tutor): identical
/// interrogation tools — click = gloss popup, drag = reveal, right-click =
/// analysis. The learner needs to double-check their own words exactly as
/// much as the tutor's.
function TokenSpan({
  tok,
  revealed,
  hasTranslation,
  onTap,
  onDragStart,
  onDragOver,
  onInspect,
  onHold,
}: {
  tok: GuidedToken
  revealed: boolean
  hasTranslation: boolean
  onTap: (e: React.MouseEvent<HTMLSpanElement>) => void
  onDragStart: () => void
  onDragOver: () => void
  onInspect: (e: React.MouseEvent<HTMLSpanElement>) => void
  onHold: () => void
}) {
  const tappable = !!tok.gloss || hasTranslation
  // Press-and-hold (450ms, near-stationary) opens the deep word-insight
  // modal. Works for mouse + touch; a plain click never fires it, and
  // dragging cancels it.
  const holdTimer = useRef<number | null>(null)
  const heldRef = useRef(false)
  const pressPos = useRef<{ x: number; y: number } | null>(null)
  const [holding, setHolding] = useState(false)
  const startHold = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    heldRef.current = false
    pressPos.current = { x: e.clientX, y: e.clientY }
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      heldRef.current = true
      setHolding(true)
      onHold()
    }, 450)
  }
  const cancelHold = () => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    setHolding(false)
  }
  const trackHoldMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (holdTimer.current === null) return
    const p = pressPos.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancelHold()
  }
  const clickTap = (e: React.MouseEvent<HTMLSpanElement>) => {
    if (heldRef.current) {
      heldRef.current = false // the long-press just fired — suppress the click
      return
    }
    onTap(e)
  }
  return (
    <span className="wu">
      <span
        className={`w ${tok.notable ? 'notice' : ''}${tappable ? ' tap' : ''}${
          revealed ? ' revealed' : ''
        }${holding ? ' holding' : ''}`}
        data-gloss-trigger={tappable || undefined}
        onClick={tappable ? clickTap : undefined}
        onPointerDown={startHold}
        onPointerMove={trackHoldMove}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onMouseDown={tappable ? onDragStart : undefined}
        onMouseEnter={tappable ? onDragOver : undefined}
        onContextMenu={tappable ? onInspect : undefined}
      >
        {tok.text}
      </span>
      {revealed && tok.gloss && <span className="wg">{tok.gloss}</span>}
    </span>
  )
}

/// Memoized: during streaming, every delta re-renders only the turn that
/// changed — not the whole conversation.
const TurnView = memo(function TurnView({
  turn,
  focused,
  ttsReady,
  revealed,
  onReveal,
  onBubbleTap,
  onSpeak,
  onPopup,
  onInspect,
  onHold,
  onToggleReveal,
}: TurnViewProps) {
  const assistant = turn.assistant
  const dragRef = useRef({ active: false, start: -1, last: -1, moved: false })

  const replyEntries = useMemo(
    () => (assistant && assistant.tokens.length > 0 ? tokenEntries(assistant.tokens) : []),
    [assistant]
  )
  const userEntries = useMemo(
    () => (assistant && assistant.user_tokens && assistant.user_tokens.length > 0 ? tokenEntries(assistant.user_tokens) : []),
    [assistant]
  )

  const beginDrag = (turnId: number, gi: number) => {
    dragRef.current = { active: true, start: gi, last: gi, moved: false }
    const up = () => {
      // Drag ending: the drag-start word gets its gloss revealed too.
      const d = dragRef.current
      if (d.moved && d.start >= 0) onReveal([`${turnId}:${d.start}`])
      d.active = false
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mouseup', up)
  }
  const dragOver = (turnId: number, gi: number) => {
    const d = dragRef.current
    if (!d.active || gi === d.last) return
    d.last = gi
    d.moved = true
    onReveal([`${turnId}:${gi}`])
  }

  const tokenTap = (
    tok: GuidedToken,
    si: number,
    translation: string | null,
    e: React.MouseEvent<HTMLSpanElement>
  ) => {
    if (dragRef.current.moved) return // drag ended on this span — no popup
    const pos = popupAnchor(e.currentTarget)
    const show = (text: string) =>
      onPopup((prev) => (prev && prev.text === text ? null : { text, ...pos }))
    if (tok.gloss) {
      show(tok.gloss)
      return
    }
    // Punctuation token: reveal that sentence's translation.
    if (!translation) return
    const parts = splitSentences(translation)
    show(parts.length === sentencesLen(parts) ? parts[si] ?? translation : translation)
  }
  const sentencesLen = (parts: string[]) => parts.length

  const bubbleTap = () => onBubbleTap(turn.id)

  const renderTokens = (
    entries: TokenEntry[],
    turnId: number,
    side: 'me' | 'bot',
    translation: string | null,
    rawText: string
  ) => (
    <span className="line">
      {entries.map(({ tok, si }, gi) => {
        const key = `${turnId}:${gi}`
        const isRevealed = revealed.has(key)
        return (
          <TokenSpan
            key={`${side}-${gi}`}
            tok={tok}
            revealed={isRevealed}
            hasTranslation={!!translation}
            onTap={(e) => tokenTap(tok, si, translation, e)}
            onDragStart={() => beginDrag(turnId, gi)}
            onDragOver={() => dragOver(turnId, gi)}
            onInspect={(e) => {
              e.preventDefault()
              onInspect(turnId, side, gi)
            }}
            onHold={() => {
              const sents = splitSentences(rawText)
              onHold(tok.text, sents[si] ?? rawText)
            }}
          />
        )
      })}
    </span>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {turn.user && (
        <div
          className={`msg me${userEntries.length ? '' : ' plain'}`}
          onDoubleClick={() =>
            assistant && onToggleReveal(assistant.user_tokens.map((_, i) => `${turn.id}:${i}`))
          }
        >
          {userEntries.length > 0
            ? renderTokens(userEntries, turn.id, 'me', assistant?.user_translation ?? null, turn.user ?? '')
            : turn.user}
        </div>
      )}
      {assistant && (
        <div
          role="button"
          tabIndex={0}
          onClick={bubbleTap}
          onDoubleClick={() =>
            assistant && onToggleReveal(assistant.tokens.map((_, i) => `${turn.id}:${i}`))
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter') bubbleTap()
          }}
          className={`msg bot ${focused ? 'focused' : ''}${ttsReady ? ' with-speak' : ''}`}
        >
          {assistant.tokens.length > 0 ? (
            renderTokens(
              replyEntries,
              turn.id,
              'bot',
              assistant.translation,
              assistant.reply
            )
          ) : (
            assistant.reply
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
function CoachFeed({
  turns,
  targetLangCode,
  nativeLangCode,
}: {
  turns: Turn[]
  targetLangCode: string
  nativeLangCode: string
}) {
  const latest = [...turns]
    .reverse()
    .find((t) => t.user !== null && (t.coach || t.coachError))

  if (!latest) {
    return (
      <div className="break-scroll coach-feed">
        <p className="center-note">
          Say something — your coach will weigh in here.
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
                <span className="split-k target">{targetLangCode.toUpperCase()}</span>
                <span>{c.used_target.join(' · ')}</span>
              </div>
            )}
            {c.used_native.length > 0 && (
              <div className="split-row">
                <span className="split-k native">{nativeLangCode.toUpperCase()}</span>
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

export default function GuidedPage({ settingsVersion = 0 }: { settingsVersion?: number }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [pinnedId, setPinnedId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [plan, setPlan] = useState<TeachingPlan | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const autoSpeak = settings?.auto_speak ?? false
  const [wordPopup, setWordPopup] = useState<PopupState | null>(null)
  const closePopup = useCallback(() => setWordPopup(null), [])
  // Android back closes overlays instead of exiting the app.
  useEffect(
    () => (wordPopup ? openOverlay(closePopup) : undefined),
    [wordPopup, closePopup]
  )
  const [breakOpen, setBreakOpen] = useState<boolean>(
    () => localStorage.getItem(BREAK_STORAGE_KEY) !== 'closed'
  )
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
  const onSplitDown = (e: React.PointerEvent) => {
    const el = breakRef.current
    if (!el) return
    e.preventDefault()
    const startY = e.clientY
    const startPct = splitPct
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const pct = startPct + ((ev.clientY - startY) / rect.height) * 100
      const clamped = Math.min(80, Math.max(20, pct))
      setSplitPct(clamped)
      localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(clamped)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // Coach / Analysis vertical split — both visible by default, drag to
  // resize, each collapsible.
  const [coachCollapsed, setCoachCollapsed] = useState<boolean>(
    () => localStorage.getItem(COACH_COLLAPSED_KEY) === '1'
  )
  const [analysisCollapsed, setAnalysisCollapsed] = useState<boolean>(
    () => localStorage.getItem(ANALYSIS_COLLAPSED_KEY) === '1'
  )
  const [splitPct, setSplitPct] = useState<number>(() => {
    const v = Number(localStorage.getItem(SPLIT_STORAGE_KEY))
    return Number.isFinite(v) && v >= 20 && v <= 80 ? v : 45
  })
  const toggleCoach = useCallback(() => {
    setCoachCollapsed((c) => {
      localStorage.setItem(COACH_COLLAPSED_KEY, c ? '0' : '1')
      return !c
    })
  }, [])
  const toggleAnalysis = useCallback(() => {
    setAnalysisCollapsed((c) => {
      localStorage.setItem(ANALYSIS_COLLAPSED_KEY, c ? '0' : '1')
      return !c
    })
  }, [])
  const onBubbleTap = useCallback(
    (id: number) => {
      setPinnedId(id)
      if (!breakOpen) openBreak()
      if (coachCollapsed) toggleCoach()
    },
    [breakOpen, openBreak, coachCollapsed, toggleCoach]
  )
  const [planOpen, setPlanOpen] = useState(false)
  useEffect(
    () => (planOpen ? openOverlay(() => setPlanOpen(false)) : undefined),
    [planOpen]
  )
  const [steerLevel, setSteerLevel] = useState<string>(
    () => localStorage.getItem('glossa_level') ?? 'beginner'
  )
  const [steerTopic, setSteerTopic] = useState<string>(
    () => localStorage.getItem('glossa_topic') ?? ''
  )
  const [ttsReady, setTtsReady] = useState(speechSupported())
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set())
  const onReveal = useCallback((keys: string[]) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      for (const k of keys) next.add(k)
      return next
    })
  }, [])
  const [inspect, setInspect] = useState<{ turn: number; side: 'me' | 'bot'; index: number } | null>(
    null
  )

  const speakReply = useCallback(
    (text: string) => {
      const lang = settings?.target_language ?? 'es-ES'
      const engine = settings?.tts_engine ?? 'cloud'
      const voice = settings?.tts_voice || 'nova'
      void speakSmart(text, lang, engine, voice).then((ok) => {
        if (!ok) logWarn('[tts] speech unavailable or empty text')
      })
    },
    [settings?.target_language, settings?.tts_engine, settings?.tts_voice]
  )

  const streamRef = useRef<HTMLDivElement | null>(null)
  const nextIdRef = useRef(1)
  const turnsRef = useRef<Turn[]>([])
  turnsRef.current = turns
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const silencePollRef = useRef<number | null>(null)
  const [recAnalyser, setRecAnalyser] = useState<AnalyserNode | null>(null)
  const breakRef = useRef<HTMLDivElement | null>(null)

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
    // Greeting fires once per module session; a new session also clears the
    // coach thread.
    if (isTauri && !sessionGreeted) {
      sessionGreeted = true
      logInfo('[guided] firing greeting turn')
      void requestTurn({ greeting: true })
      void invoke('coach_thread_clear')
        .then(() => setCoachThread([]))
        .catch((e) => logWarn('[coach] thread reset failed:', e))
      setRevealed(new Set())
      setFreshScaffolds(null)
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
  }, [settingsVersion])

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
        level: steerLevel,
        topic: steerTopic || '(any)',
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
              onBubbleTap(pendingId)
              break
            case 'analysis_section':
              // Turn scaffolds are the freshest suggestions — feed the chips.
              if (event.scaffolds) setFreshScaffolds(event.scaffolds)
              updatePending((t) =>
                t.assistant
                  ? {
                      ...t,
                      assistant: {
                        ...t.assistant,
                        tokens: event.tokens ?? t.assistant.tokens,
                        translation: event.translation ?? t.assistant.translation,
                        user_tokens: event.user_tokens ?? t.assistant.user_tokens,
                        user_translation: event.user_translation ?? t.assistant.user_translation,
                        mechanics: event.mechanics ?? t.assistant.mechanics,
                        scaffolds: event.scaffolds ?? t.assistant.scaffolds,
                      },
                    }
                  : t
              )
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
            case 'analysis_done':
              logInfo(
                `[guided] analysis arrived in ${(performance.now() - turnStarted).toFixed(0)}ms:`,
                {
                  tokens: event.turn.tokens.length,
                  mechanics: event.turn.mechanics.length,
                  scaffolds: `${event.turn.scaffolds.replies.length}/${event.turn.scaffolds.frames.length}/${event.turn.scaffolds.starters.length}`,
                }
              )
              // End of turn = freshest suggestions for the NEXT message.
              setFreshScaffolds(event.turn.scaffolds)
              updatePending((t) => ({
                ...t,
                assistant: event.turn,
                analysisState: 'done',
              }))
              break
            case 'analysis_failed':
              logWarn('[guided] analysis failed (reply-only turn):', event.error)
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
              const norm = normalizeDocs(event.plan, event.profile)
              setPlan(norm.plan)
              setProfile(norm.profile)
              break
          }
        }
        await invoke<string>('guided_turn', {
          message: body.message ?? '',
          history,
          greeting: body.greeting ?? false,
          level: steerLevel,
          topic: steerTopic || null,
          onEvent: channel,
        })
        // Command resolved = reply pass done (fallback if the event raced).
        setSending(false)
        updatePending((t) =>
          t.assistant ? t : { ...t, assistant: emptyAssistant(t.pendingText), analysisState: 'pending', pendingText: '' }
        )
      } catch (e) {
        logError('[guided] turn failed:', e)
        setTurns((prev) => prev.filter((t) => t.id !== pendingId))
        setError(String(e).replace(/^Error:\s*/, ''))
        setSending(false)
      }
    },
    [autoSpeak, onBubbleTap, speakReply, steerLevel, steerTopic]
  )

  // Language pair changed → full conversation reset aligned to the new
  // pairing: turns, reveals, scaffolds, Q&A, and the coach thread are all
  // pair-specific (Rust archives the old documents on save; the greeting
  // fires fresh in the new language).
  const langPair = settings ? `${settings.target_language}|${settings.native_language}` : null
  const prevLangPair = useRef<string | null>(null)
  useEffect(() => {
    if (!langPair) return
    const prev = prevLangPair.current
    prevLangPair.current = langPair
    if (prev === null || prev === langPair) return
    logInfo('[guided] language pair changed:', prev, '->', langPair, '— resetting conversation')
    setTurns([])
    setPinnedId(null)
    setRevealed(new Set())
    setFreshScaffolds(null)
    setQaPairs([])
    setCoachThread([])
    setInspect(null)
    setWordPopup(null)
    setError(null)
    setSending(false)
    stopSpeaking()
    sessionGreeted = false
    void requestTurn({ greeting: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langPair])


  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

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

  // Display name from the shared language list — no ad-hoc mapping.
  const targetLanguageName = settings
    ? (LANGUAGES.find((l) => l.code === settings.target_language)?.name ??
       settings.target_language.split('-')[0].toUpperCase())
    : ''
  const nativeLanguageName = settings
    ? (LANGUAGES.find((l) => l.base === settings.native_language)?.name ??
       settings.native_language.toUpperCase())
    : ''

  const latestScaffolds: Scaffolds | undefined = [...turns]
    .reverse()
    .find(
      (t) =>
        t.assistant &&
        (t.assistant.scaffolds.replies.length > 0 ||
          t.assistant.scaffolds.frames.length > 0 ||
          t.assistant.scaffolds.starters.length > 0)
    )?.assistant?.scaffolds
  const pinnedTurn =
    turns.find(
      (t) => t.id === (pinnedId ?? latestAssistantId) && t.assistant
    ) ?? null

  // Right-click on a word: pin the turn, open the breakdown, highlight the
  // token in the word lists.
  const onWordInspect = useCallback(
    (turnId: number, side: 'me' | 'bot', index: number) => {
      setPinnedId(turnId)
      setInspect({ turn: turnId, side, index })
      if (!breakOpen) openBreak()
      if (analysisCollapsed) toggleAnalysis()
    },
    [breakOpen, openBreak, analysisCollapsed, toggleAnalysis]
  )

  // Deep word insight (press-and-hold / analysis-pane click): a modal that
  // hydrates lemma, morphology, grammatical role, and a usage note.
  const [wordInsight, setWordInsight] = useState<{ word: string; sentence: string } | null>(
    null
  )
  const closeInsight = useCallback(() => setWordInsight(null), [])
  const onHoldWord = useCallback(
    (word: string, sentence: string) => setWordInsight({ word, sentence }),
    []
  )

  // Reveal toggling: drag adds; dblclick toggles the whole bubble
  // (reveal-all ⇄ hide-all).
  const onToggleReveal = useCallback((keys: string[]) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      const allOn = keys.every((k) => prev.has(k))
      for (const k of keys) {
        if (allOn) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }, [])

  const [freshScaffolds, setFreshScaffolds] = useState<Scaffolds | null>(null)
  const [scaffoldsLoading, setScaffoldsLoading] = useState(false)
  const [scaffoldsError, setScaffoldsError] = useState<string | null>(null)
  const scaffoldsLoadingRef = useRef(false)
  const [scaffoldsOpen, setScaffoldsOpen] = useState<boolean>(
    () => localStorage.getItem('glossa_scaffolds') !== 'closed'
  )
  const toggleScaffolds = useCallback(() => {
    setScaffoldsOpen((o) => {
      localStorage.setItem('glossa_scaffolds', o ? 'closed' : 'open')
      return !o
    })
  }, [])
  // Chips: fresh steer-driven scaffolds win; otherwise the newest turn that
  // produced any (best-available across turns).
  const chipsForUI: Scaffolds =
    freshScaffolds ??
    latestScaffolds ?? { replies: [], frames: [], starters: [] }

  // Analysis highlight: scroll the inspected token into view.
  useEffect(() => {
    if (!inspect) return
    const el = document.querySelector('.tok.inspected')
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [inspect])


  // Coach thread (interactive sidebar chat — private to the learner).
  const [coachThread, setCoachThread] = useState<{ role: string; content: string }[]>([])
  const [coachInput, setCoachInput] = useState('')
  const [coachThinking, setCoachThinking] = useState(false)
  useEffect(() => {
    if (!isTauri) return
    void invoke<{ role: string; content: string }[]>('get_coach_thread')
      .then(setCoachThread)
      .catch((e) => logWarn('[coach] thread load failed:', e))
  }, [settingsVersion])
  const coachAsk = useCallback(
    async (question: string) => {
      const q = question.trim()
      if (!q || coachThinking) return
      setCoachThinking(true)
      setCoachThread((t) => [...t, { role: 'user', content: q }])
      try {
        const ctx = turnsRef.current
          .slice(-8)
          .flatMap((t) =>
            [
              t.user ? `LEARNER: ${t.user}` : null,
              t.assistant ? `NATIVE: ${t.assistant.reply}` : null,
            ].filter(Boolean) as string[]
          )
          .join('\n')
        const res = await invoke<{ reply: string }>('coach_ask', { question: q, context: ctx })
        setCoachThread((t) => [...t, { role: 'coach', content: res.reply }])
      } catch (e) {
        logError('[coach] ask failed:', e)
        setCoachThread((t) => [...t, { role: 'coach', content: `⚠ ${String(e)}` }])
      } finally {
        setCoachThinking(false)
      }
    },
    [coachThinking]
  )
  const coachClear = useCallback(() => {
    void invoke('coach_thread_clear').catch((e) => logWarn('[coach] clear failed:', e))
    setCoachThread([])
  }, [])

  // Analysis Q&A (session-scoped; cleared with the coach thread on a new
  // conversation — the greeting effect bumps a shared session counter).
  const [qaPairs, setQaPairs] = useState<{ q: string; a: string }[]>([])
  useEffect(() => {
    setQaPairs([])
  }, [settingsVersion])
  const [qaInput, setQaInput] = useState('')
  const [qaThinking, setQaThinking] = useState(false)

  // Fresh scaffolds: regenerated when steering changes, so suggestions track
  // level/topic instead of going stale. Turn analysis clears this override.
  const regenerateScaffolds = useCallback(
    async (level: string, topic: string) => {
      if (!isTauri || scaffoldsLoadingRef.current) return
      scaffoldsLoadingRef.current = true
      setScaffoldsLoading(true)
      setScaffoldsError(null)
      try {
        const history = turnsRef.current
          .filter((t) => t.assistant !== null)
          .flatMap((t) => {
            const items: { role: string; content: string }[] = []
            if (t.user) items.push({ role: 'user', content: t.user })
            items.push({ role: 'assistant', content: t.assistant!.reply })
            return items
          })
            .slice(-8)
        const s = await invoke<Scaffolds>('generate_scaffolds', {
          req: { history, level, topic: topic || null },
        })
        setFreshScaffolds(s)
      } catch (e) {
        setScaffoldsError(String(e).replace(/^Error:\s*/, ''))
      } finally {
        scaffoldsLoadingRef.current = false
        setScaffoldsLoading(false)
      }
    },
    []
  )
  // Regenerate when steering changes (skips the very first render).
  const steerInitialized = useRef(false)
  useEffect(() => {
    if (!steerInitialized.current) {
      steerInitialized.current = true
      return
    }
    const t = setTimeout(() => void regenerateScaffolds(steerLevel, steerTopic), 300)
    return () => clearTimeout(t)
  }, [steerLevel, steerTopic, regenerateScaffolds])
  const askAnalysis = useCallback(async () => {
    const q = qaInput.trim()
    if (!q || qaThinking) return
    const pinned = turnsRef.current.find((t) => t.id === pinnedId) ?? null
    const ctx = [
      pinned?.user ? `LEARNER SAID: ${pinned.user}` : null,
      pinned?.assistant?.user_translation ? `(meant: ${pinned.assistant.user_translation})` : null,
      pinned?.assistant ? `TUTOR REPLIED: ${pinned.assistant.reply}` : null,
      pinned?.assistant?.translation ? `(${pinned.assistant.translation})` : null,
      pinned?.assistant?.mechanics.length
        ? `GRAMMAR NOTES: ${pinned.assistant.mechanics.map((m) => m.title).join('; ')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n')
    setQaThinking(true)
    setQaInput('')
    try {
      const a = await invoke<string>('analysis_ask', { question: q, context: ctx })
      setQaPairs((p) => [...p, { q, a }])
    } catch (e) {
      setQaPairs((p) => [...p, { q, a: `⚠ ${String(e)}` }])
    } finally {
      setQaThinking(false)
    }
  }, [qaInput, qaThinking, pinnedId])

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
              revealed={revealed}
              onReveal={onReveal}
              onBubbleTap={onBubbleTap}
              onSpeak={speakReply}
              onPopup={setWordPopup}
              onInspect={onWordInspect}
              onHold={onHoldWord}
              onToggleReveal={onToggleReveal}
            />
          ))}
          {error && <div className="err">{error}</div>}
        </div>

        {/* Composer */}
        <div className="composer">
          <div className="scaffold-block">
            <div className="scaffold-block-head">
              <span className="scaffold-block-title">Suggestions · for your next message</span>
              <span className="scaffold-status">
                {scaffoldsLoading
                  ? '⟳ writing…'
                  : scaffoldsError
                    ? `⚠ ${scaffoldsError}`
                    : ''}
              </span>
              <button
                type="button"
                className="scaffold-toggle"
                onClick={toggleScaffolds}
                aria-expanded={scaffoldsOpen}
                title={scaffoldsOpen ? 'Hide suggestions' : 'Show suggestions'}
              >
                {scaffoldsOpen ? '▾' : '▸'}
              </button>
            </div>
            {scaffoldsOpen && (
              <div className="scaffold-groups">
                <ScaffoldRow label="Say it" items={chipsForUI.replies} onPick={(s) => void send(s)} />
                <ScaffoldRow label="Build it" items={chipsForUI.frames} onPick={(f) => setInput(f)} />
                <ScaffoldRow label="Start it" items={chipsForUI.starters} onPick={(s) => setInput(`${s} `)} />
              </div>
            )}
          </div>
          {recording && recAnalyser && (
            <WaveformStrip analyserNode={recAnalyser} height={44} timelineSeconds={10} />
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
      <section className={`break ${breakOpen ? '' : 'collapsed'}`} ref={breakRef}>
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

        {/* Coach pane (top of the vertical split) */}
        <section
          className={`subpanel ${coachCollapsed ? 'collapsed' : ''}`}
          style={
            coachCollapsed
              ? undefined
              : analysisCollapsed
                ? { flex: '1 1 auto' }
                : { flex: `0 0 ${splitPct}%` }
          }
        >
          <div className="subpanel-head">
            <span className="k">Coach</span>
            <button
              type="button"
              className="subpanel-toggle"
              onClick={toggleCoach}
              aria-expanded={!coachCollapsed}
              title={coachCollapsed ? 'Expand coach' : 'Collapse coach'}
            >
              {coachCollapsed ? '▸' : '▾'}
            </button>
          </div>
          {!coachCollapsed && (
            <>
              <CoachFeed
                turns={turns}
                targetLangCode={(settings?.target_language ?? 'es-ES').split('-')[0].toUpperCase()}
                nativeLangCode={(settings?.native_language ?? 'en').toUpperCase()}
              />
              <div className="coach-thread">
                {coachThread.map((m, i) => (
                  <div key={i} className={`coach-msg ${m.role}`}>
                    {m.content}
                  </div>
                ))}
                {coachThinking && <div className="coach-msg coach">⟳ thinking…</div>}
              </div>
              <form
                className="coach-input-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  void coachAsk(coachInput)
                  setCoachInput('')
                }}
              >
                <input
                  className="coach-input"
                  value={coachInput}
                  onChange={(e) => setCoachInput(e.target.value)}
                  placeholder="Ask the coach…"
                  disabled={!isTauri}
                  lang={settings?.native_language ?? 'en'}
                />
                <button type="submit" className="coach-send" disabled={!coachInput.trim() || coachThinking}>
                  ↑
                </button>
                <button
                  type="button"
                  className="coach-clear"
                  title="Clear coach thread"
                  onClick={coachClear}
                >
                  ⌫
                </button>
              </form>
            </>
          )}
        </section>

        {/* Resize divider */}
        {breakOpen && !coachCollapsed && !analysisCollapsed && (
          <div className="split-bar" onPointerDown={onSplitDown} title="Drag to resize" />
        )}

        {/* Analysis pane (bottom of the vertical split) */}
        <section
          className={`subpanel analysis-pane ${analysisCollapsed ? 'collapsed' : ''}`}
          style={analysisCollapsed ? undefined : { flex: '1 1 auto' }}
        >
          <div className="subpanel-head">
            <span className="k">Analysis</span>
            <button
              type="button"
              className="subpanel-toggle"
              onClick={toggleAnalysis}
              aria-expanded={!analysisCollapsed}
              title={analysisCollapsed ? 'Expand analysis' : 'Collapse analysis'}
            >
              {analysisCollapsed ? '▸' : '▾'}
            </button>
          </div>
          {!analysisCollapsed && (
            <>
              <div className="analysis-scroll">
                {pinnedTurn?.assistant ? (
                  <div>
                    {pinnedTurn.analysisState === 'pending' && (
                      <p className="sect-k" style={{ color: 'var(--steel)', marginBottom: 12 }}>
                        ⟳ Analyzing grammar…
                      </p>
                    )}
                    <p className="sect-k" style={{ marginBottom: 8 }}>
                      You said
                    </p>
                    {pinnedTurn.assistant?.user_tokens && pinnedTurn.assistant.user_tokens.length > 0 ? (
                      <p className="sentence">
                        {pinnedTurn.assistant.user_tokens.map((tok, i) => {
                          const prev =
                            i > 0 ? pinnedTurn.assistant!.user_tokens[i - 1].text : ''
                          return (
                            <span key={i}>
                              {i > 0 && needsSpaceBetween(prev, tok.text) ? ' ' : ''}
                              <span className={tok.notable ? 'hl' : ''}>{tok.text}</span>
                            </span>
                          )
                        })}
                      </p>
                    ) : pinnedTurn.user ? (
                      <p className="sentence">{pinnedTurn.user}</p>
                    ) : null}
                    {pinnedTurn.assistant?.user_translation && (
                      <p className="trans-d">{pinnedTurn.assistant?.user_translation}</p>
                    )}

                    <p className="sect-k" style={{ marginBottom: 8 }}>
                      Tutor replied
                    </p>
                    {pinnedTurn.assistant && (
                      <>
                        {pinnedTurn.assistant.tokens.length > 0 ? (
                          <p className="sentence">
                            {pinnedTurn.assistant.tokens.map((tok, i) => {
                              const prev = i > 0 ? pinnedTurn.assistant!.tokens[i - 1].text : ''
                              return (
                                <span key={i}>
                                  {i > 0 && needsSpaceBetween(prev, tok.text) ? ' ' : ''}
                                  <span className={tok.notable ? 'hl' : ''}>{tok.text}</span>
                                </span>
                              )
                            })}
                          </p>
                        ) : (
                          <p className="sentence">{pinnedTurn.assistant.reply}</p>
                        )}
                        {pinnedTurn.assistant.translation && (
                          <p className="trans-d">{pinnedTurn.assistant.translation}</p>
                        )}
                      </>
                    )}

                    {pinnedTurn.assistant && pinnedTurn.assistant.tokens.length > 0 && (
                      <>
                        <p className="sect-k">Tutor words</p>
                        <div className="gloss">
                          {pinnedTurn.assistant.tokens.map((tok, i) => (
                            <div
                              key={i}
                              className={`tok ${tok.notable ? 'key' : ''} ${
                                inspect?.turn === pinnedTurn.id && inspect?.side === 'bot' && inspect.index === i
                                  ? 'inspected'
                                  : ''
                              }`}
                            >
                              <span className="sp">{tok.text}</span>
                              {tok.gloss && <span className="gl">{tok.gloss}</span>}
                              {tok.pos && <span className="po">{tok.pos}</span>}
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {pinnedTurn.assistant?.user_tokens && pinnedTurn.assistant?.user_tokens.length > 0 && (
                      <>
                        <p className="sect-k">Your words</p>
                        <div className="gloss">
                          {pinnedTurn.assistant?.user_tokens.map((tok, i) => (
                            <div
                              key={i}
                              className={`tok ${tok.notable ? 'key' : ''} ${
                                inspect?.turn === pinnedTurn.id && inspect?.side === 'me' && inspect.index === i
                                  ? 'inspected'
                                  : ''
                              }`}
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
                                <span>vs {nativeLanguageName || 'your language'}</span>
                                {mech.contrast}
                              </p>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                ) : (
                  <p className="center-note">
                    The breakdown of the tutor&apos;s latest reply lands here.
                  </p>
                )}

                {/* Analysis Q&A thread */}
                {qaPairs.length > 0 && (
                  <div className="qa-thread">
                    {qaPairs.map((p, i) => (
                      <div key={i} className="qa-pair">
                        <div className="qa-q">{p.q}</div>
                        <div className="qa-a">{p.a}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <form
                className="qa-input-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  void askAnalysis()
                }}
              >
                <input
                  className="qa-input"
                  value={qaInput}
                  onChange={(e) => setQaInput(e.target.value)}
                  placeholder="Ask about the analysis…"
                  disabled={!isTauri}
                  lang={settings?.native_language ?? 'en'}
                />
                <button type="submit" className="qa-send" disabled={!qaInput.trim() || qaThinking}>
                  ↑
                </button>
              </form>
            </>
          )}
        </section>
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
      {wordInsight && (
        <WordInsightModal
          word={wordInsight.word}
          sentence={wordInsight.sentence}
          onClose={closeInsight}
        />
      )}
    </div>
  )
}