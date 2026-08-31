import { memo, useMemo, useRef, useState } from 'react'
import type { GuidedToken, GuidedTurnResult } from '../../types'
import { popupAnchor, type PopupState } from '../GlossPopup'

export interface TurnShape {
  id: number
  user: string | null
  assistant: GuidedTurnResult | null
  pendingText: string
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

// Tokens carry their trailing punctuation ("hoy?"), so a token ending in
// terminal punctuation closes its sentence.
const TERMINAL_PUNCT = /[.!?…]/

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?…]+[.!?…]*/g) ?? []).map((s) => s.trim()).filter(Boolean)
}

function groupSentences(tokens: GuidedToken[]): GuidedToken[][] {
  const sentences: GuidedToken[][] = [[]]
  for (const tok of tokens) {
    sentences[sentences.length - 1].push(tok)
    if (TERMINAL_PUNCT.test(tok.text)) sentences.push([])
  }
  if (sentences[sentences.length - 1].length === 0) sentences.pop()
  return sentences
}

interface TokenSpanProps {
  tok: GuidedToken
  revealed: boolean
  hasTranslation: boolean
  onTap: (e: React.MouseEvent<HTMLSpanElement>) => void
  onDragStart: () => void
  onDragOver: () => void
  onInspect: (e: React.MouseEvent<HTMLSpanElement>) => void
  onHold: () => void
}

function TokenSpan({
  tok,
  revealed,
  hasTranslation,
  onTap,
  onDragStart,
  onDragOver,
  onInspect,
  onHold,
}: TokenSpanProps) {
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
        onMouseDown={onDragStart}
        onMouseEnter={onDragOver}
        onContextMenu={onInspect}
      >
        {tok.text}
      </span>
      {revealed && tok.gloss && <span className="wg">{tok.gloss}</span>}
    </span>
  )
}

export interface TurnViewProps {
  turn: TurnShape
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

/// Memoized: during streaming, every delta re-renders only the turn that
/// changed — not the whole conversation.
export const TurnView = memo(function TurnView({
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
    () =>
      assistant && assistant.user_tokens && assistant.user_tokens.length > 0
        ? tokenEntries(assistant.user_tokens)
        : [],
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
    show(parts[si] ?? translation)
  }
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
