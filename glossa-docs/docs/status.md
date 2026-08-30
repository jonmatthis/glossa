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
| Async analysis (tokens/translation/mechanics/scaffolds) with per-section degradation | `commands.rs:353-508` |
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

### R1 · CEFR is hard-coded A2 for guided chat
`commands.rs:195` — `let cefr = "A2".to_string(); // TODO: onboarding level picker`.
Every prompt (persona, mechanics) tells the model the learner is A2
regardless of reality. The Profile's `level_notes` exists but nothing feeds
it back into the worker prompts. **This is the biggest pedagogical gap:**
an intermediate learner still gets A2 treatment.

### R2 · Contract drift: TS `Settings` missing `observer_model` — **FIXED**
TS type now mirrors the Rust struct and the Settings modal exposes the
observer model; saving no longer silently resets it.

### R3 · Nothing is committed / no CI / no tests
One commit ("Initial commit"); the entire `src/`, `src-tauri/`, and docs
trees are untracked. Zero tests (Rust or TS), no lint config, no GitHub
Actions. Any refactor is currently blind.

### R4 · Conversation history not persisted
Turns live only in React state. Continuity across restarts is carried solely
by plan/profile. A `session.json` (or SQLite) with the turn log is the
missing piece for "resume where I left off" and for future SRS/analytics.

### R5 · README overstates key isolation
README claims keys "never shipped to the webview." In fact `get_settings`
returns the full Settings **including key material** to the frontend
(`commands.rs:22-29`); GuidedPage and SettingsModal both receive it. Keys
never leave the machine, but they do cross the IPC boundary. Either fix the
claim or fix the code (return masked keys; accept keys only via
`save_settings`).

### R6 · One language per install, documents not namespaced
`plan.json` / `profile.json` / story caches are not keyed by target
language. Switch from Spanish to Japanese mid-life leaves the observer
rewriting Japanese-language plan data from Spanish habits, and story caches
mix. Namespace by target language (or multi-profile) before making
language-switching a first-class flow.

### R7 · Observer cadence & counters — **partially fixed**
- `learner_turns` dead counter: **removed**.
- `Profile.sessions` still never incremented (observer prompt doesn't ask).
- Cadence: observer runs **every turn**, non-overlapping (comment/code
  now aligned here and in docs).

### R8 · `features` is dead weight — **REMOVED**
Field deleted from the Rust wire type, TS type, and the "Grammar spotted"
render block. (Habla·ES leftover; the mechanic cards fully supersede it.)

### R9 · Mobile-readiness gaps (pre-scaffold)
`gen/` contains only schemas — `tauri android init` / `tauri ios init` have
not been run. Desktop capability file only; mic permissions
(`RECORD_AUDIO`, `NSMicrophoneUsageDescription`) unconfigured; STT assumes
webm (`audio.webm` hardcoded, `commands.rs:672`) while iOS produces mp4/aac;
desktop-only CSS (fixed split pane, 1200×800 window). Details in
[Platforms](./platforms).

### R10 · Reply `max_tokens: 600` can truncate
Streaming replies cap at 600 output tokens with a bump to 1200 only on the
reasoning-param retry path (`ai.rs:114,161`). Advanced-level replies or
longer greetings risk silent truncation. Consider raising or making it
level-aware.

### R11 · Frontend duplicates language data
`lib/tauri.ts:37-60` re-lists the languages from `languages.rs` (fine), but
`GuidedPage.tsx:326-332` *also* re-implements display names with its own
ad-hoc mapping ("es-ES" → "Spanish", else `split('-')[0].toUpperCase()`),
which yields e.g. "EN-GB" as a header. Route display names through the
shared list.

### R12 · Plaintext API keys
Keys sit in `settings.json` in the config dir (chmod-unguarded on Windows).
Acceptable for a PoC; the roadmap answer is OS keychain via a Tauri plugin
(`tauri-plugin-stronghold` or keyring crate), with plaintext as fallback.

### R13 · CSP is null
`tauri.conf.json` → `app.security.csp: null`. Fine for dev; should be set
before any public distribution.

### R14 · Assorted sharp edges
- Story cache restore only looks up the `beginner` slot regardless of last
  used level (`StoriesPage.tsx:58`).
- `localStorage.glossa_target` can go stale vs. actual settings if settings
  change outside the app.
- Settings modal requests mic permission as a side effect of opening (to
  enumerate devices, `SettingsModal.tsx:47`).
- Mic auto-stop hardcoded at 10s (`GuidedPage.tsx:311`).
- `sanitize_reply` markers are Spanish/English-centric (`commands.rs:142`).
- Whisper model + Groq endpoint hardcoded (`commands.rs:675`).
- `transcribe_audio` builds a new reqwest client per call (fine at PoC scale).
- Story "exactly 2" scaffolds are validated only as non-empty.
- Docs site config has placeholder URL (`url: https://github.com`, FreeMoCap
  Discord footer) to be personalized.

## What does not exist yet (explicitly)

- Onboarding (level picker, first-run flow beyond Settings)
- Any persistence of chat; any export
- SRS / vocabulary layer
- Cloud TTS (Groq PlayAI etc.) — basic OS-voice TTS **is** implemented
  (Web Speech API: 🔊 per bubble + auto-speak toggle); cloud quality upgrade
  is a fast-follow
- Mobile scaffolds, CI pipelines, installers for mac/Linux (config targets
  "all" but untested)
- Localization of the UI itself (English-only chrome)
- Tests, benches, telemetry (none, by design for now)

## Suggested order of battle (small bites)

1. **Commit the working tree.** Lowest-risk highest-value action today.
2. R2 (TS contract fix) + R7 (remove or wire dead counters) — small hygiene.
3. R1 (CEFR picker) — biggest pedagogical win, touches settings + prompts.
4. R4 (persist conversation) — unlocks resume, export, analytics.
5. R6 (namespace by language) — before language-switching becomes a feature.
6. R5/R12/R13 (security pass) — before any distribution.
7. R9 (mobile scaffolds) — after desktop stabilizes.
