import { memo } from 'react'
import type { GuidedToken, GuidedTurnResult } from '../../types'
import { needsSpaceBetween } from '../../lib/token-spacing'

export interface InspectTarget {
  turn: number
  side: 'me' | 'bot'
  index: number
}

interface AnalysisContentProps {
  turn: {
    id: number
    user: string | null
    analysisState: 'pending' | 'done' | 'failed' | null
    assistant: GuidedTurnResult | null
  }
  inspect: InspectTarget | null
  nativeLanguageName: string
  qaPairs: { q: string; a: string }[]
}

/// The pinned turn's full breakdown: learner words, tutor words, per-token
/// gloss lists, grammar mechanics, and the analysis Q&A thread.
export const AnalysisContent = memo(function AnalysisContent({
  turn,
  inspect,
  nativeLanguageName,
  qaPairs,
}: AnalysisContentProps) {
  const a = turn.assistant
  if (!a) {
    return (
      <p className="center-note">
        The breakdown of the tutor&apos;s latest reply lands here.
      </p>
    )
  }

  const highlighted = (side: 'me' | 'bot', i: number) =>
    inspect?.turn === turn.id && inspect?.side === side && inspect.index === i
      ? 'inspected'
      : ''

  const tokenSentence = (tokens: GuidedToken[]) => (
    <p className="sentence">
      {tokens.map((tok, i) => {
        const prev = i > 0 ? tokens[i - 1].text : ''
        return (
          <span key={i}>
            {i > 0 && needsSpaceBetween(prev, tok.text) ? ' ' : ''}
            <span className={tok.notable ? 'hl' : ''}>{tok.text}</span>
          </span>
        )
      })}
    </p>
  )

  const glossList = (tokens: GuidedToken[], side: 'me' | 'bot') => (
    <div className="gloss">
      {tokens.map((tok, i) => (
        <div key={i} className={`tok ${tok.notable ? 'key' : ''} ${highlighted(side, i)}`}>
          <span className="sp">{tok.text}</span>
          {tok.gloss && <span className="gl">{tok.gloss}</span>}
          {tok.pos && <span className="po">{tok.pos}</span>}
        </div>
      ))}
    </div>
  )

  return (
    <>
      {turn.analysisState === 'pending' && (
        <p className="sect-k" style={{ color: 'var(--steel)', marginBottom: 12 }}>
          ⟳ Analyzing grammar…
        </p>
      )}

      <p className="sect-k" style={{ marginBottom: 8 }}>
        You said
      </p>
      {a.user_tokens && a.user_tokens.length > 0 ? (
        tokenSentence(a.user_tokens)
      ) : turn.user ? (
        <p className="sentence">{turn.user}</p>
      ) : null}
      {a.user_translation && <p className="trans-d">{a.user_translation}</p>}

      <p className="sect-k" style={{ marginBottom: 8 }}>
        Tutor replied
      </p>
      {a.tokens.length > 0 ? tokenSentence(a.tokens) : <p className="sentence">{a.reply}</p>}
      {a.translation && <p className="trans-d">{a.translation}</p>}

      {a.tokens.length > 0 && (
        <>
          <p className="sect-k">Tutor words</p>
          {glossList(a.tokens, 'bot')}
        </>
      )}

      {a.user_tokens && a.user_tokens.length > 0 && (
        <>
          <p className="sect-k">Your words</p>
          {glossList(a.user_tokens, 'me')}
        </>
      )}

      {a.errors.length > 0 && (
        <div className="turn-errors">
          {a.errors.map((e, i) => (
            <div key={i}>⚠ {e}</div>
          ))}
        </div>
      )}

      {a.mechanics.length > 0 && (
        <>
          <p className="sect-k">What&apos;s happening</p>
          {a.mechanics.map((mech) => (
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
    </>
  )
})
