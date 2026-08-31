import { useCallback, useEffect, useRef, useState } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  GuidedEvent,
  GuidedTurnResult,
  Profile,
  Settings,
  Scaffolds,
  TeachingPlan,
} from '../types'
import { GlossPopup, type PopupState } from '../components/GlossPopup'
import { getPlan, getSettings, isTauri, LANGUAGES } from '../lib/tauri'
import { openOverlay } from '../lib/back'
import { loadVoices, speakSmart, speechSupported, stopSpeaking } from '../lib/speech'
import { comboFromEvent } from '../lib/keyboard'
import { normalizeDocs } from '../lib/normalize'
import { WaveformStrip } from '../components/WaveformStrip'
import { WordInsightModal } from '../components/WordInsightModal'
import { TurnView } from '../components/chat/TurnView'
import { CoachFeed } from '../components/panes/CoachFeed'
import { AnalysisContent } from '../components/panes/AnalysisContent'
import { logError, logInfo, logWarn } from '../lib/log'
import { STEER_LEVELS, STEER_TOPICS, useSteering, armGreeting, disarmGreeting } from '../hooks/useSteering'
import { useMicRecorder } from '../hooks/useMicRecorder'
import { usePersistentToggle } from '../hooks/useSteering'

interface Turn {
  id: number
  user: string | null
  assistant: GuidedTurnResult | null
  pendingText: string
  analysisState: 'pending' | 'done' | 'failed' | null
  coach?: { comprehensibility: number; grammar: number; remark: string; used_target: string[]; used_native: string[]; corrections: { said: string; corrected: string; kind: string; explanation: string }[] }
  coachError?: string
}

const SPLIT_STORAGE_KEY = 'glossa_split'
const COACH_COLLAPSED_KEY = 'glossa_coach_collapsed'
const ANALYSIS_COLLAPSED_KEY = 'glossa_analysis_collapsed'

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

export default function GuidedPage({ settingsVersion = 0 }: { settingsVersion?: number }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [pinnedId, setPinnedId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [plan, setPlan] = useState<TeachingPlan | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [ttsReady, setTtsReady] = useState(speechSupported())
  const autoSpeak = settings?.auto_speak ?? false
  const [wordPopup, setWordPopup] = useState<PopupState | null>(null)
  const closePopup = useCallback(() => setWordPopup(null), [])
  const [planOpen, setPlanOpen] = useState(false)
  useEffect(
    () => (planOpen ? openOverlay(() => setPlanOpen(false)) : undefined),
    [planOpen]
  )
  useEffect(
    () => (wordPopup ? openOverlay(() => setWordPopup(null)) : undefined),
    [wordPopup]
  )
  const { open: breakOpen, toggle: toggleBreak } = usePersistentToggle('glossa_break', true)
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
  const steer = useSteering()
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
  const breakRef = useRef<HTMLDivElement | null>(null)

  const settingsRef = useRef<Settings | null>(null)
  settingsRef.current = settings
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {})
  const toggleMicRef = useRef<() => void>(() => {})
  const toggleBreakRef = useRef<() => void>(() => {})

  useEffect(() => {
    logInfo('[guided] page mounted, isTauri =', isTauri)
    void loadVoices().then((v) => {
      setTtsReady(v.length > 0 || speechSupported())
      if (!v.length) logWarn('[tts] no OS voices found — speech disabled')
    })
    // Greeting fires once per module session; a new session also clears the
    // coach thread.
    if (isTauri && armGreeting()) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsVersion])

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  const onBubbleTap = useCallback(
    (id: number) => {
      setPinnedId(id)
      if (!breakOpen) toggleBreak()
      if (coachCollapsed) toggleCoach()
    },
    [breakOpen, toggleBreak, coachCollapsed, toggleCoach]
  )
  const requestTurn = useCallback(
    async (body: { message?: string; greeting?: boolean }) => {
      setSending(true)
      setError(null)
      logInfo('[guided] turn start:', {
        greeting: body.greeting ?? false,
        message: body.message ?? '',
        level: steer.level,
        topic: steer.topic || '(any)',
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
          level: steer.level,
          topic: steer.topic || null,
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
    [autoSpeak, onBubbleTap, speakReply, steer.level, steer.topic]
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
    disarmGreeting()
    void requestTurn({ greeting: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langPair])

  async function send(text: string) {
    const message = text.trim()
    if (!message || sending) return
    setInput('')
    stopSpeaking() // new turn: silence any ongoing playback
    await requestTurn({ message })
  }
  sendRef.current = send
  toggleBreakRef.current = toggleBreak

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

  // Romanization shows for targets whose script needs it (Arabic → ALA-LC).
  const showRomanization =
    settings != null &&
    (LANGUAGES.find((l) => l.code === settings.target_language)?.romanization ??
      null) !== null

  // RTL targets render token lines right-to-left.
  const rtl =
    settings != null &&
    (LANGUAGES.find((l) => l.code === settings.target_language)?.direction ??
      'ltr') === 'rtl'

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
    turns.find((t) => t.id === (pinnedId ?? latestAssistantId) && t.assistant) ?? null

  // Right-click on a word: pin the turn, open the breakdown, highlight the
  // token in the word lists.
  const onWordInspect = useCallback(
    (turnId: number, side: 'me' | 'bot', index: number) => {
      setPinnedId(turnId)
      setInspect({ turn: turnId, side, index })
      if (!breakOpen) toggleBreak()
      if (analysisCollapsed) toggleAnalysis()
    },
    [breakOpen, toggleBreak, analysisCollapsed, toggleAnalysis]
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

  // Fresh scaffolds: regenerated when steering changes, so suggestions track
  // level/topic instead of going stale. Turn analysis clears this override.
  const [freshScaffolds, setFreshScaffolds] = useState<Scaffolds | null>(null)
  const [scaffoldsLoading, setScaffoldsLoading] = useState(false)
  const [scaffoldsError, setScaffoldsError] = useState<string | null>(null)
  const { open: scaffoldsOpen, toggle: toggleScaffolds } = usePersistentToggle('glossa_scaffolds', true)
  const scaffoldsLoadingRef = useRef(false)
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
  const steerInitialized = useRef(false)
  useEffect(() => {
    if (!steerInitialized.current) {
      steerInitialized.current = true
      return
    }
    const t = setTimeout(() => void regenerateScaffolds(steer.level, steer.topic), 300)
    return () => clearTimeout(t)
  }, [steer.level, steer.topic, regenerateScaffolds])

  // Chips: fresh steer-driven scaffolds win; otherwise the newest turn that
  // produced any (best-available across turns).
  const chipsForUI: Scaffolds =
    freshScaffolds ??
    latestScaffolds ?? { replies: [], frames: [], starters: [] }

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

  // Analysis Q&A (session-scoped).
  const [qaPairs, setQaPairs] = useState<{ q: string; a: string }[]>([])
  const [qaInput, setQaInput] = useState('')
  const [qaThinking, setQaThinking] = useState(false)
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

  // Analysis highlight: scroll the inspected token into view.
  useEffect(() => {
    if (!inspect) return
    const el = document.querySelector('.tok.inspected')
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [inspect])

  const mic = useMicRecorder({
    micDeviceId: settings?.microphone_device_id,
    onTranscribe: (text: string) => {
      if (text) {
        if (settingsRef.current?.auto_send) {
          logInfo('[mic] auto-send enabled — sending transcription')
          void sendRef.current(text)
        } else {
          setInput((prev) => (prev ? `${prev} ${text}` : text))
        }
      } else logWarn('[mic] transcription was empty (silence?)')
    },
    buildPrompt: () => {
      // Whisper context hint. Keep it TARGET-LANGUAGE ONLY: the hint text
      // itself teaches the model what language to emit, so English content
      // here causes doubled Arabic+English transcripts. Few natural words
      // from the recent conversation are the strongest bias.
      const lines = turnsRef.current
        .slice(-4)
        .flatMap((t) => [t.user, t.assistant?.reply].filter(Boolean) as string[])
      return [...lines].join('\n').slice(0, 850)
    },
  })
  toggleMicRef.current = mic.toggleMic

  // Analysis highlight scroll.
  useEffect(() => {
    if (!inspect) return
    const el = document.querySelector('.tok.inspected')
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [inspect])

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
              showRomanization={showRomanization}
              rtl={rtl}
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
          {mic.recording && mic.recAnalyser && (
            <WaveformStrip analyserNode={mic.recAnalyser} height={44} timelineSeconds={10} />
          )}
          <div className="steer-row">
            <select
              className="steer-select"
              value={steer.level}
              onChange={(e) => steer.setLevel(e.target.value)}
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
              value={steer.topic}
              onChange={(e) => steer.setTopic(e.target.value)}
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
              onClick={steer.randomTopic}
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
              className={`mic ${mic.recording ? 'recording' : ''}`}
              onClick={mic.toggleMic}
              disabled={!isTauri || sending}
              title={mic.recording ? 'Stop recording' : 'Record audio'}
              aria-label={mic.recording ? 'Stop recording' : 'Record audio'}
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
                {pinnedTurn ? (
                  <AnalysisContent
                    turn={pinnedTurn}
                    inspect={inspect}
                    nativeLanguageName={nativeLanguageName}
                    showRomanization={showRomanization}
                    rtl={rtl}
                    qaPairs={qaPairs}
                  />
                ) : (
                  <p className="center-note">
                    The breakdown of the tutor&apos;s latest reply lands here.
                  </p>
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
