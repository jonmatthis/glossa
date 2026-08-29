---
sidebar_position: 2
title: Overview
---

# Glossa — Overview

**Glossa is a standalone, no-login, multilingual language tutor.** A desktop
(Tauri v2) app today, with mobile ambitions. No accounts, no server, no
database: everything is local except the AI calls, which go to OpenRouter
(chat) and Groq (speech-to-text) with keys the user supplies themselves.

**Status: working Proof of Concept (v0.1.0).** The guided-conversation loop is
end-to-end functional on Windows. See [Status](./status) for the full inventory.

## The product idea

You talk to a tutor in the language you're learning. The tutor talks back in
that language — always — and adjusts how much help it gives you with a single
dial. Behind the scenes, a slow "observer" model watches the conversation and
keeps two small documents (a session **Teaching Plan** and a cross-session
**Profile**) that steer the fast tutor model: what to practice, which errors
to gently recast, what not to re-teach.



## The two surfaces

| Surface | What it is | Where |
|---|---|---|
| **Guided** | Assist-slider conversation: streamed tutor reply + live grammar breakdown (per-word glosses, POS, explainer cards, reply scaffolds), voice input via Groq Whisper, learner-visible teaching plan. | `src/pages/GuidedPage.tsx` |
| **Stories** | Level-matched short stories (beginner / intermediate / advanced) with tap-to-translate word glosses. | `src/pages/StoriesPage.tsx` |

## The assist dial (the core UX primitive)

One slider, 0–3, persisted in `localStorage`:

| Level | Name | Chat pane | Composer scaffolds |
|---|---|---|---|
| 0 | Immersion | Reply text only | none |
| 1 | Light | Key words highlighted | 2–4 word starters |
| 2 | Guided | Per-word glosses under words | Fill-in-the-blank frames (`___`) |
| 3 | Full support | + full translation in-pane | Complete tap-to-send replies |

The dial changes three things at once: what the **frontend renders**, what
**scaffolds the scaffolder worker produces** (all three lists are always
generated; the UI just picks by level), and a line in the **reply prompt**
("current assist level: …"). It does *not* change which workers run.

## The agent architecture in one paragraph

Every turn triggers up to three kinds of LLM work, all OpenRouter
(OpenAI-compatible), none talking to each other directly:

1. **Reply worker** (fast, reasoning disabled, streamed) — writes the actual
   tutor reply. The turn resolves as soon as it finishes.
2. **Four analysis workers** (parallel one-shots, reasoning disabled) —
   tokenize + gloss the reply, translate it, write 1–2 grammar mechanic
   cards, and build the next-turn scaffolds. Delivered asynchronously;
   per-section degradation (a failed sub-call costs its section only).
3. **Observer** (reasoning model, background, never overlaps itself) —
   rewrites the TeachingPlan and Profile from the transcript. Learner-visible
   via the "Plan" drawer.

Full detail in [Architecture](./architecture); the data contracts are nailed
down in [Ontology](./ontology).




## Document map

- [Architecture](./architecture) — components, IPC surface, turn pipeline, agent roles, persistence.
- [Ontology](./ontology) — every domain entity, field-by-field, with lifecycle and ownership.
- [Status](./status) — what works, what's partial, what's missing, tech-debt inventory.
- [Platforms & Build](./platforms) — desktop today; the concrete path to Android/iOS.
