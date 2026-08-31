---
sidebar_position: 5
title: Status
---

# Status — where Glossa actually stands

Honest inventory as of the v0.1.0 PoC audit (Aug 2026). Frame: **what works,
what's rough, what doesn't exist.** Every claim is checkable against the code
(`file:line` references included).

## Verdict in three sentences

The core loop — greet → converse with a streamed tutor reply → async grammar
analysis → observer quietly steering via plan/profile — is **implemented and
coherent**, with unusually mature LLM-error handling for a PoC (schema
inlining, prompted-JSON fallback, corrective retries, per-section
degradation, non-overlapping observer). The app is **single-user,
single-language, A2-only, desktop-only**, with no tests, no CI, no
conversation persistence, and a handful of contract drifts between the Rust
and TS types. Everything is currently **uncommitted** (single "Initial
commit"; the whole app tree is untracked).

## What works end-to-end

| Capability | Evidence |
|---|---|
| Guided conversation with streaming replies | `commands.rs::guided_turn`, `GuidedPage.requestTurn` |
| Async analysis (reply + LEARNER tokens/translation, mechanics, scaffolds) with per-section degradation | `commands.rs` analysis spawn |
| **Language pair switching** — en-US ⇄ fr-FR ⇄ es-ES ⇄ ar-LE (Levantine), any native language; documents archived on switch; full conversation reset + fresh greeting in the new language | `languages.rs`, `commands.rs::save_settings`, `GuidedPage` pair-change effect |
| **Arabic (Levantine)** — RTL script, ALA-LC romanization alongside glosses (skellysubs IP), unvocalized typing convention; **Whisper gets a context hint** (recent turns + focus + vocab) because lower-resource languages need the bias | `languages.rs` (direction + romanization fields), `GuidedToken.romanization`, `transcribe_audio(prompt)`, `.wroman`/`.proman` UI |
| **Coach sidebar** — per-message feedback (remark, corrections, scores, language-split), **interactive persisted coach thread**, analysis Q&A | `commands.rs` coach pass + `coach_ask`/`get_coach_thread`, `coach.md`, Coach pane |
| **Voice I/O** — cloud TTS playback via OpenRouter gpt-audio-mini (cached, OS-voice fallback), mic with 20s-silence auto-stop, **live scrolling waveform**, optional auto-send; 🔊 replay; configurable shortcuts | `commands.rs::speak_text`, `components/WaveformStrip.tsx`, `lib/speech.ts`, `lib/keyboard.ts` |
| **Learner interrogation** — your own messages get tokenized + translated; click/drag/dblclick/right-click/press-and-hold on learner AND tutor words | `LearnerTokensOut`, `TokenSpan`, `word_insight` command, `WordInsightModal` |
| **Interactive coach thread** — persisted private side-chat with the coach; analysis Q&A input | `coach_ask`, `coach_thread.json`, Coach pane input |
| Observer pass, non-overlapping, plan/profile persisted + learner-visible drawer | `commands.rs:262-351`, `observer.rs` |
| Anti-repetition (taught ledger + 20-card ring) | `observer.rs::directives_block`, `commands.rs:483-496` |
| Structured output fallback ladder | `ai.rs::structured_validated` |
| Stories: generation, validation, tap-gloss, per-level cache | `commands.rs:558-619`, `StoriesPage.tsx` |
| Voice input → Whisper STT → composer (not auto-send) | `GuidedPage.toggleMic`, `commands.rs::transcribe_audio` |
| Assist dial 0–3 affecting render + prompts + scaffolds | `GuidedPage`, `prompts.rs::ASSIST_LEVEL_NAMES` |
| Logging across the IPC boundary (console + file + webview) | `lib.rs` log plugin, `lib/log.ts` |
| Settings persistence incl. mic device selection | `settings.rs`, `SettingsModal.tsx` |

## Known issues / tech-debt inventory

Ranked roughly by "will bite us next."

### R1 · CEFR hard-coding — **coarse picker SHIPPED, adaptive remains open**
The steer row (level picker) feeds beginner/intermediate/advanced →
A2/B1/C1 into every prompt. Fine-grained/adaptive leveling (driven by
`Profile.level_notes` evidence) remains future work.

### R2 · Contract drift: TS `Settings` missing `observer_model` — **FIXED**
TS type now mirrors the Rust struct and the Settings modal exposes the
observer model; saving no longer silently resets it.

### R3 · Testing/CI — **improved, CI still missing**
Unit tests now exist (6 Rust + 12 vitest covering the pure functions that
bit us; model bench harness for LLM candidate evaluation). Still missing:
CI pipeline (clippy + tsc + vitest + docs build), lint config.

### R4 · Conversation history not persisted
Turns live only in React state. Continuity across restarts is carried solely
by plan/profile. A `session.json` (or SQLite) with the turn log is the
missing piece for "resume where I left off" and for future SRS/analytics.

### R5 · README overstates key isolation — **FIXED**
Keys no longer travel to the webview at all: `get_settings` returns masked
values (`••••last4`), `save_settings` treats an unchanged mask as
"keep stored key", and `validate_key` resolves masks server-side.

### R6 · One language per install, documents not namespaced — **FIXED (archive + reset on switch)**
On a target/native language change, `save_settings` archives
`plan.json`, `profile.json`, and `coach_thread.json` with a timestamp and
resets the in-memory documents; the GuidedPage detects the pair change and
resets the conversation (turns, reveals, Q&A, coach thread) and fires a
fresh greeting in the new language. Archived files keep every old document
recoverable. Full multi-profile (instant switch-back) remains future work.

### R7 · Observer cadence & counters — **partially fixed**
- `learner_turns` dead counter: **removed**.
- `Profile.sessions` still never incremented (observer prompt doesn't ask).
- Cadence: observer runs **every turn**, non-overlapping (comment/code
  now aligned here and in docs).

### R8 · `features` is dead weight — **REMOVED**
Field deleted from the Rust wire type, TS type, and the "Grammar spotted"
render block. (Habla·ES leftover; the mechanic cards fully supersede it.)

### R9 · Mobile — **Android SHIPPED**, iOS unscaffolded
Android builds + runs (emulator dev loop + sideload APK, see
[Platforms](./platforms)); manifest carries mic permissions, keyboard
resize fixed, STT format verified webm/opus. Open: iOS scaffolding
(needs Mac + Apple dev account; STT upload type must switch to mp4/aac).

### R10 · Reply `max_tokens: 600` can truncate
Streaming replies cap at 600 output tokens with a bump to 1200 only on the
reasoning-param retry path (`ai.rs:114,161`). Advanced-level replies or
longer greetings risk silent truncation. Consider raising or making it
level-aware.

### R11 · Frontend duplicates language data — **largely fixed**
Display names now come from the shared TS list; Rust remains the deep
authority (overlays, iso639). Full IPC-sourcing deferred until the ladder
adds a second language.

### R12 · Plaintext API keys
Keys sit in `settings.json` in the config dir (chmod-unguarded on Windows).
Acceptable for a PoC; the roadmap answer is OS keychain via a Tauri plugin
(`tauri-plugin-stronghold` or keyring crate), with plaintext as fallback.

### R13 · CSP is null — **FIXED**
Strict CSP in `tauri.conf.json` per Tauri docs (self + ipc + asset only —
the app loads no remote content).

### R14 · Assorted sharp edges — **partially fixed**
- Story cache restore only looks up the `beginner` slot regardless of last
  used level (`StoriesPage.tsx`). — **open**
- Stale scaffold chips when generation fails — **fixed**: steering changes
  regenerate scaffolds via a dedicated `generate_scaffolds` command; failures
  surface as a visible ⚠ in the suggestion header (best-available fallback
  remains, now with visible cause).
- `localStorage.glossa_target` can go stale vs. actual settings. — **open**
- Settings modal requests mic permission as a side effect of opening. —
  **fixed**: mic enumeration happens only when the Audio & Voice section is
  visited (the settings shell was also restructured into a two-column
  tree + search — see below).
- Mic auto-stop: **redesigned** — toggle on/off manually; recording
  auto-stops after 20s of silence (WebAudio RMS detection), not 10s wall-clock.
  — **fixed**
- Whisper model, Groq endpoint, upload mime: **centralized as named
  constants** (H5).
- `sanitize_reply` markers are Spanish/English-centric — **documented in
  [Future Work](./future-work) ladder notes** (H7).
- `transcribe_audio` builds a new reqwest client per call (fine at PoC scale).
- Story scaffolds: shape + emptiness now enforced at the schema level
  (`minItems`) — fixed by the flat-schema rework.
- Docs site config has placeholder URL / FreeMoCap footer — **open**
  (cosmetic).

## Audit 2026-08-30 — robustness & mobile pass (in progress)

Full audit findings; worked chunk by chunk, this table is the tracker.

| ID | Finding | Status |
|---|---|---|
| B1 | Observer `observer_running` flag stuck `true` forever if the observer task panicked → observer silently disabled permanently. Fixed with a panic-safe RAII guard. | ✅ |
| B2 | Tab switch (Guided↔Stories) unmounted GuidedPage and destroyed the conversation. Both pages now stay mounted; inactive page is `display:none`. | ✅ |
| B3 | Android back button exits app instead of closing topmost overlay. | ✅ lib/back.ts history-entry stack — opening an overlay pushes state, back closes topmost; wired into word popup, plan drawer, logs panel, Settings |
| M1 | iOS auto-zoom on focus: inputs < 16px font (`.field` 14px, Settings 13.5px). Fix: 16px inputs. | ✅ 16px on ≤860px viewports |
| M2 | Logs fab (fixed bottom-left) overlaps the composer on mobile. Re-dock. | ✅ docked beside the topbar gear |
| M3 | 🔊 button (absolute top-right of bubble) can overlap reply text. | ✅ `with-speak` reserves right padding |
| M4 | Gloss popups clip at viewport edges (x not clamped) — Stories + Guided. | ✅ shared `popupAnchor` clamps x |
| M5 | Plan drawer lacks safe-area bottom padding. | ✅ plus: the drawer had NO CSS at all (never styled) — full drawer styles added |
| M6 | Input semantics: chat input missing `lang` (keyboard predictions), `enterkeyhint`, autocapitalize tuning; Settings inputs need scrollIntoView on keyboard open. | ✅ `lang`/`enterKeyHint`/`autoCorrect`/`spellCheck` on chat input; focus-scroll on modal |
| M7 | Missing `overscroll-behavior: contain` on scrollers; no tap-highlight policy. | ✅ |
| P2 | Diagnostic logs (`[viewport]`, `[mic] peak`) at info level → downgrade to debug. | ✅ |
| S1 | CSP null → strict CSP per Tauri docs (we load no remote content; near-free). | ✅ strict CSP in tauri.conf.json |
| S2 | `get_settings` ships API keys to the webview → masked-keys + save-only. | ✅ masked round-trip: `••••last4`; unchanged masks keep stored keys; validation resolves masks |
| S3 | Keys plaintext on disk → keychain/stronghold later. | ⬜ future |
| H1 | Language lists duplicated (Rust, TS constants, ad-hoc display map in GuidedPage). Single source via IPC. | 🟡 display map now uses the shared TS list; full IPC sourcing deferred |
| H2 | GuidedPage duplication: empty-assistant literal ×2, normalizeDocs call sites ×3 → helpers. | ✅ `emptyAssistant()` + `normalizeDocs` moved to `lib/normalize.ts` |
| H3 | App.tsx dead `settings` value + `localStorage.glossa_target` second source of truth. | ✅ dead state removed |
| H4 | GuidedPage ~990 lines → split components (optional refactor). | ⬜ |
| H5 | Hardcoded constants scattered: mic 10s auto-stop, Whisper model, Groq endpoint, webm mime. | ✅ named constants (MIC_* in GuidedPage, GROQ_STT_*/TTS_* in commands.rs) |
| H6 | `schema_dump` debug bin builds in all profiles — gate or delete. | ✅ moved to `examples/` |
| H7 | `sanitize_reply` markers es/en-centric — fold into future-work ladder notes. | ✅ documented in Future Work dialect notes |
| E1 | No unit tests for the pure functions that bit us: `inline_defs`, `normalizeDocs`, `token-spacing`, `groupSentences/splitSentences`. | ✅ 6 Rust tests (inline_defs regression, mask, migrate) + 12 vitest cases (`npm test`) |
| E2 | No CI: clippy + tsc + docs build gate. | ✅ `.github/workflows/ci.yml` (clippy -D warnings, cargo test --lib, vitest + tsc + vite, docs build) |
| D1 | status.md R-list drifted after the week's fixes — refresh at end of audit. | ✅ |

## What does not exist yet (explicitly)

- Onboarding (level picker, first-run flow beyond Settings)
- Any persistence of chat; any export
- SRS / vocabulary layer
- Cloud TTS: **shipped** (OpenRouter gpt-audio-mini, cached, OS fallback)
  (Web Speech API: 🔊 per bubble + auto-speak toggle); cloud quality upgrade
  is a fast-follow
- Mobile scaffolds, CI pipelines, installers for mac/Linux (config targets
  "all" but untested)
- Localization of the UI itself (English-only chrome)
- Tests, benches, telemetry (none, by design for now)

## Structural refactor (decomposition) — **PASS 1 SHIPPED**

`GuidedPage` dropped from ~1,850 to ~1,100 lines; the extracted pieces:

| Piece | Lines | Contents |
|---|---|---|
| `components/chat/TurnView.tsx` | ~290 | memoized turn renderer, TokenSpan (click/drag/hold/dblclick interrogation), sentence grouping |
| `components/panes/CoachFeed.tsx` | ~100 | per-message coaching card + score meters |
| `components/panes/AnalysisContent.tsx` | ~140 | pinned-turn breakdown + Q&A thread |
| `hooks/useMicRecorder.ts` | ~140 | full mic lifecycle: permissions, capture, silence auto-stop, analyser, Whisper |
| `hooks/useSteering.ts` | ~65 | level/topic steering, persistent toggles, greeting guard |

**Next pass (same pattern, when these files are next touched):**
- GuidedPage remains ~1,100 lines — remaining extractable pieces: the plan
  drawer (render + refresh), the shortcuts hook, and the scaffold
  regeneration hook. Target: GuidedPage as pure state + layout.
- The plan-drawer section renderers repeat a render-list pattern that
  AnalysisContent now encapsulates — fold them on next touch.
- Shortcut logic (`useShortcuts`) and scaffold regeneration (`useScaffolds`)
  are the next two hooks to extract.


File sizes have crossed the threshold where single-file sections hurt:

| File | Lines | Pressure |
|---|---|---|
| `src/pages/GuidedPage.tsx` | ~1,600 | Chat stream, composer, coach pane, analysis pane, split-panel drag, shortcuts, mic, inspection — one god component |
| `src/components/SettingsModal.tsx` | ~580 | Registry-driven but rows embed full JSX; localize/validate logic inline |
| `src/lib/i18n.ts` | ~360 | Fine (data), grows one block per locale |

Planned decomposition (do when touching these files next, not before):

- `GuidedPage` → `components/chat/` (TurnView, TokenSpan, Composer, ScaffoldRow),
  `components/panes/` (CoachPane, AnalysisPane with Q&A), `hooks/` (useReveal,
  useShortcuts, useMicRecorder, useSteering). The token-interaction logic
  (click/drag/hold/dblclick) is the piece most worth isolating — it is shared
  by learner and tutor bubbles and will grow (word-insight hydration).
- `SettingsModal` → row components extracted from the registry; the registry
  itself is the right shape, the rows just need to stop embedding raw JSX.
- Duplication to collapse when splitting: the token-rendering closure appears
  per bubble; the plan-drawer section renderers repeat the same pattern.
- After the split, sweep for cross-file duplication (normalizeDocs callers,
  score meters, popup anchoring) and collapse into `lib/`.

## Suggested order of battle (small bites)

1. **Commit the working tree.** Lowest-risk highest-value action today.
2. R2 (TS contract fix) + R7 (remove or wire dead counters) — small hygiene.
3. R1 (CEFR picker) — biggest pedagogical win, touches settings + prompts.
4. R4 (persist conversation) — unlocks resume, export, analytics.
5. R6 (namespace by language) — before language-switching becomes a feature.
6. R5/R12/R13 (security pass) — before any distribution.
7. R9 (mobile scaffolds) — after desktop stabilizes.
