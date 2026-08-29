# Glossa

A standalone, no-login, multilingual language tutor — desktop app (Tauri v2).

Two surfaces, ported from the FreeLingo/Habla·ES lineage:

- **Guided** — the assist-slider conversation: paper chat + live grammar
  breakdown (word glosses, features, explainer cards, reply scaffolds),
  with voice input via Groq Whisper.
- **Stories** — level-matched short stories (beginner / intermediate /
  advanced) with tap-to-translate word glosses.

## Architecture

```
Rust core (src-tauri)          React + Vite + TS frontend (src)
├─ OpenAI-compatible client    ├─ Guided conversation (two-pass:
│  (OpenRouter; streaming +     streamed reply + structured analysis
│  json_schema structured       with validation retries)
│  output + fallbacks)        ├─ Stories reader (tokenized text,
├─ Settings persistence         tap-for-gloss popover, level chips)
│  (JSON in app config dir)   └─ Two-layer design: paper conversation /
└─ Groq Whisper STT              dark analysis (Habla·ES tokens)
```

- **API keys** are stored locally in the OS config dir and used only by the
  Rust core — never shipped to the webview.
- Structured output uses native `json_schema` response format with a
  prompted-JSON fallback and one validation-retry pass (the FreeLingo
  lessons, applied to API providers).
- No accounts, no server, no Docker. Everything is local except the AI calls.

## Run

```powershell
cd glossa
npm install
npm run tauri dev     # first run compiles the Rust core (~2-5 min)
```

On first launch: open Settings (⚙) → paste your OpenRouter key (required) and
Groq key (only needed for voice input) → pick the language you're learning and
your native language.

## Build an installer

```powershell
npm run tauri build   # NSIS installer + portable exe under src-tauri/target/release/bundle
```

## Layout

- `src-tauri/src/ai.rs` — provider client (streaming, schema-constrained
  structured output, fallback ladder, `$defs` inlining)
- `src-tauri/src/prompts.rs` — shared persona/mandatory-rules blocks,
  guided + story prompts (ported from the FreeLingo prompt library)
- `src-tauri/src/languages.rs` — supported languages + per-variant overlays
- `src-tauri/src/commands.rs` — the IPC surface: `guided_turn`,
  `generate_story`, `transcribe_audio`, settings
- `src/pages/GuidedPage.tsx`, `src/pages/StoriesPage.tsx` — the two surfaces

## Docs

Full documentation lives in [`glossa-docs/`](./glossa-docs) (Docusaurus):

- [Overview](./glossa-docs/docs/overview.md) — what Glossa is, the assist dial, the agent architecture
- [Architecture](./glossa-docs/docs/architecture.md) — IPC surface, turn pipeline, prompt composition
- [Ontology](./glossa-docs/docs/ontology.md) — every domain entity, field-by-field
- [Status](./glossa-docs/docs/status.md) — what works, known issues, order of battle
- [Platforms & Build](./glossa-docs/docs/platforms.md) — desktop today, Android/iOS path

```powershell
cd glossa-docs && npm install && npm start   # preview the docs site
```
