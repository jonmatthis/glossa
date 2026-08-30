//! Tauri commands — the whole v0.1 IPC surface:
//! settings, guided conversation (two-pass reply+analysis), stories, STT.

use base64::Engine;
use serde::{Deserialize, Serialize};
use log::{error, info, warn};
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::ai::Provider;
use crate::languages::{iso639, language_display, native_display, overlay};
use crate::observer;
use crate::prompts;
use crate::settings;
use crate::settings::Settings;
use crate::AppState;

// ─── API key validation ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct KeyStatus {
    pub valid: bool,
    pub detail: String,
}

/// Lightweight reachability check for an API key: OpenRouter's auth endpoint
/// for chat keys, Groq's model list for STT keys. Never logs or returns the
/// key itself.
#[tauri::command]
pub async fn validate_key(provider: String, key: String) -> Result<KeyStatus, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Ok(KeyStatus {
            valid: false,
            detail: "no key entered".into(),
        });
    }
    let url = match provider.as_str() {
        "openrouter" => "https://openrouter.ai/api/v1/auth/key",
        "groq" => "https://api.groq.com/openai/v1/models",
        other => return Err(format!("unknown provider: {other}")),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    match status.as_u16() {
        200 => {
            let detail = if provider == "openrouter" {
                response
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| v["data"]["label"].as_str().map(str::to_string))
                    .unwrap_or_else(|| "key accepted".into())
            } else {
                "key accepted".into()
            };
            Ok(KeyStatus { valid: true, detail })
        }
        401 | 403 => Ok(KeyStatus {
            valid: false,
            detail: format!("key rejected ({status})"),
        }),
        s => Ok(KeyStatus {
            valid: false,
            detail: format!("unexpected status {s}"),
        }),
    }
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/// Retry counters for the logs overlay. Retries here are ONLY for transient
/// failures (429s, malformed model output fed back for correction) — nothing
/// falls back silently anywhere in the app.
#[tauri::command]
pub fn get_diagnostics() -> Vec<(String, u64)> {
    crate::ai::retry_stats_snapshot()
        .iter()
        .map(|(k, v)| (k.to_string(), *v))
        .collect()
}

// ─── Settings ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    info!("[cmd] get_settings");
    Ok(state
        .settings
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, mut settings: Settings) -> Result<(), String> {
    // Phone clipboards love appending whitespace to pasted keys — a dirty
    // key makes providers report "Missing Authentication header".
    settings.openrouter_key = settings.openrouter_key.trim().to_string();
    settings.groq_key = settings.groq_key.trim().to_string();
    info!(
        "[cmd] save_settings: target={} native={} model={}",
        settings.target_language,
        settings.native_language,
        settings.openrouter_model
    );
    // A failed save means the user's keys are NOT on disk — fail loudly.
    settings::persist(&state.config_dir, &settings)?;
    *state.settings.lock().unwrap_or_else(|p| p.into_inner()) = settings;
    Ok(())
}

// ─── Guided conversation ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GuidedToken {
    /// The exact word from the reply, punctuation attached.
    pub text: String,
    /// Short native-language meaning of the word in this context.
    #[serde(default)]
    pub gloss: Option<String>,
    /// Universal part of speech (NOUN, VERB, ADJ, ...).
    #[serde(default)]
    pub pos: Option<String>,
    /// Grammatically interesting form worth the learner's attention.
    #[serde(default)]
    pub notable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Mechanic {
    /// Name of the grammar mechanic.
    pub title: String,
    /// CEFR level of the mechanic, e.g. A2.
    #[serde(default)]
    pub cefr: Option<String>,
    /// 2-3 sentences explaining how the mechanic works, in the learner's native language.
    pub body: String,
    /// One worked example close to the reply, with a native-language gloss.
    #[serde(default)]
    pub example: Option<String>,
    /// How this differs from English, in the learner's native language.
    #[serde(default)]
    pub contrast: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Scaffolds {
    /// Complete sentences the learner could plausibly send next.
    #[serde(default)]
    pub replies: Vec<String>,
    /// Fill-in-the-blank sentences using ___ for the missing part.
    #[serde(default)]
    pub frames: Vec<String>,
    /// Short openers of 2-4 words.
    #[serde(default)]
    pub starters: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TokensOut {
    /// minItems is enforced at the schema level: constrained providers
    /// cannot return an empty token list.
    #[schemars(length(min = 1))]
    pub tokens: Vec<GuidedToken>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TranslationOut {
    pub translation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct MechanicsOut {
    #[schemars(length(min = 1))]
    pub mechanics: Vec<Mechanic>,
}

/// FLAT on the wire on purpose: the old `{scaffolds: {replies, ...}}`
/// wrapper made models return the inner object at the top level. Flat shape
/// + schema-level minItems = models comply. `Scaffolds` below stays the
/// public turn shape.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ScaffoldsOut {
    #[schemars(length(min = 1))]
    pub replies: Vec<String>,
    #[schemars(length(min = 1))]
    pub frames: Vec<String>,
    #[schemars(length(min = 1))]
    pub starters: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GuidedTurnResult {
    pub reply: String,
    pub translation: Option<String>,
    pub tokens: Vec<GuidedToken>,
    pub mechanics: Vec<Mechanic>,
    pub scaffolds: Scaffolds,
    /// Analysis sub-calls that FAILED after retries. Nothing degrades
    /// silently: the breakdown pane renders these as visible errors.
    pub errors: Vec<String>,
}

fn sanitize_reply(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    if text.starts_with("```") {
        text = text
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if text.ends_with("```") {
            text.truncate(text.len() - 3);
            text = text.trim().to_string();
        }
    }
    // Defensive: cut off any leaked translation/notes block.
    for marker in ["\n---", "\n***", "\n**English", "\n**Traducción"] {
        if let Some(pos) = text.find(marker) {
            text.truncate(pos);
        }
    }
    text.trim().to_string()
}

/// Events streamed to the frontend during one guided turn. The reply pass
/// resolves the turn; the analysis pass lands asynchronously afterwards so
/// the learner can keep typing while grammar notes are still being prepared.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GuidedEvent {
    ReplyDelta { text: String },
    ReplyDone { reply: String },
    /// Progressive hydration: emitted the moment ONE analysis sub-call
    /// finishes; only that section's field is Some. The frontend merges
    /// sections into the turn as they arrive instead of waiting for the
    /// slowest call.
    AnalysisSection {
        tokens: Option<Vec<GuidedToken>>,
        translation: Option<String>,
        mechanics: Option<Vec<Mechanic>>,
        scaffolds: Option<Scaffolds>,
    },
    AnalysisDone { turn: GuidedTurnResult },
    #[allow(dead_code)]
    AnalysisFailed { error: String },
    PlanUpdated {
        plan: observer::TeachingPlan,
        profile: observer::Profile,
    },
}

#[tauri::command]
pub async fn guided_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    message: String,
    history: Vec<ChatTurn>,
    assist_level: u8,
    greeting: bool,
    on_event: Channel<GuidedEvent>,
) -> Result<String, String> {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if settings.openrouter_key.is_empty() {
        warn!("[cmd] guided_turn rejected: no OpenRouter key");
        return Err("No OpenRouter API key configured. Open Settings and add your key.".into());
    }
    let started = std::time::Instant::now();
    let target = settings.target_language.clone();
    info!(
        "[cmd] guided_turn start: greeting={greeting} assist_level={assist_level} message_len={} history={} target={target}",
        message.len(),
        history.len(),
    );
    let tln = language_display(&target);
    let native = native_display(&settings.native_language);
    let cefr = "A2".to_string(); // TODO: onboarding level picker

    // ── Pass 1: conversational reply (streamed to the UI) ───────────────────
    let directives = {
        let plan = state.plan.lock().unwrap_or_else(|p| p.into_inner());
        let recent = state
            .recent_mechanics
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        observer::directives_block(&plan, &recent)
    };
    let reply_system = prompts::guided_reply_prompt(
        &target,
        &tln,
        &cefr,
        &native,
        assist_level,
        &directives,
    );
    let mut reply_messages = vec![json!({"role": "system", "content": reply_system})];
    for turn in history.iter().rev().take(30).rev() {
        reply_messages.push(json!({"role": turn.role, "content": turn.content}));
    }
    if greeting {
        reply_messages.push(json!({
            "role": "user",
            "content": "[Session start] Greet the learner warmly and ask one simple opening question they can answer at their level."
        }));
    } else {
        if message.trim().is_empty() {
            return Err("Message is empty".into());
        }
        reply_messages.push(json!({"role": "user", "content": message}));
    }

    let provider = Provider::openrouter(&settings.openrouter_key, &settings.openrouter_model);
    let channel = on_event.clone();
    let full_reply = provider
        .chat_streaming(&reply_messages, 0.6, &mut |delta| {
            let _ = channel.send(GuidedEvent::ReplyDelta {
                text: delta.to_string(),
            });
        })
        .await
        .map_err(|e| {
            let msg = format!("reply failed: {e}");
            if msg.contains("429") {
                "The tutor hit a rate limit — give it a few seconds and try again.".into()
            } else {
                msg
            }
        })?;
    let reply = sanitize_reply(&full_reply);
    if reply.is_empty() {
        return Err("The tutor returned an empty reply. Please try again.".into());
    }
    info!(
        "[cmd] guided_turn reply ready in {:.1}s: reply_len={}",
        started.elapsed().as_secs_f32(),
        reply.len()
    );
    let _ = on_event.send(GuidedEvent::ReplyDone {
        reply: reply.clone(),
    });
    // The command resolves HERE — the learner can keep talking immediately.
    // The analysis pass runs in the background and lands via the channel.

    // ── Pass 3 (background): observer pass on its own cadence ───────────────
    // Session start (greeting) + every 3rd learner turn. Runs fully parallel;
    // its output is a rewritten TeachingPlan + Profile, delivered via the
    // channel and persisted to disk.
    //
    // Runs on EVERY turn, but never overlaps itself: if the previous observer
    // pass is still thinking, this turn is skipped and the next one picks it
    // up. The plan is never more than one turn stale.
    let observer_free = {
        let mut running = state.observer_running.lock().unwrap_or_else(|p| p.into_inner());
        if *running {
            false
        } else {
            *running = true;
            true
        }
    };
    if observer_free {
        let app_for_observer = app.clone();
        let event_channel = on_event.clone();
        let transcript: Vec<String> = history
            .iter()
            .map(|t| format!("{}: {}", if t.role == "user" { "L" } else { "T" }, t.content))
            .chain(std::iter::once(format!(
                "L: {}",
                if greeting { "(session start)".to_string() } else { message.trim().to_string() }
            )))
            .chain(std::iter::once(format!("T: {reply}")))
            .collect();
        let observer_model = settings
            .observer_model
            .clone()
            .unwrap_or_else(crate::settings::default_observer_model);
        let tln_for_observer = tln.clone();
        info!("[cmd] observer pass triggered (model={observer_model})");
        tokio::spawn(async move {
            let obs_started = std::time::Instant::now();
            let state = app_for_observer.state::<AppState>();
            let (plan_snapshot, profile_snapshot, mechanics) = {
                let plan = state.plan.lock().unwrap_or_else(|p| p.into_inner());
                let profile = state.profile.lock().unwrap_or_else(|p| p.into_inner());
                let mechanics = state.recent_mechanics.lock().unwrap_or_else(|p| p.into_inner());
                (plan.clone(), profile.clone(), mechanics.clone())
            };
            let provider = Provider::openrouter(
                &state.settings.lock().unwrap_or_else(|p| p.into_inner()).openrouter_key,
                &observer_model,
            );
            // The observer USES its reasoning budget — no disable here.
            let result = observer::run_observer(
                &provider,
                &tln_for_observer,
                &transcript.join("
"),
                &plan_snapshot,
                &profile_snapshot,
                &mechanics,
            )
            .await;
            match result {
                Ok(output) => {
                    observer::persist_documents(&state.config_dir, &output.plan, &output.profile);
                    *state.plan.lock().unwrap_or_else(|p| p.into_inner()) = output.plan.clone();
                    *state.profile.lock().unwrap_or_else(|p| p.into_inner()) = output.profile.clone();
                    info!(
                        "[cmd] observer pass done in {:.1}s: focus={:?} errors={} ledger={}",
                        obs_started.elapsed().as_secs_f32(),
                        output.plan.session_focus,
                        output.plan.recurring_errors.len(),
                        output.plan.taught_ledger.len(),
                    );
                    let _ = event_channel.send(GuidedEvent::PlanUpdated {
                        plan: output.plan,
                        profile: output.profile,
                    });
                }
                Err(e) => {
                    warn!(
                        "[cmd] observer pass failed after {:.1}s (keeping previous documents): {e}",
                        obs_started.elapsed().as_secs_f32()
                    );
                }
            }
            // Free the slot — the next turn can run its own observer pass.
            *state
                .observer_running
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = false;
        });
    }

    // ── Pass 2: analysis — four small one-shot calls run concurrently ───────
    // Each sub-task is tiny (100-500 output tokens), so the wall time is the
    // slowest single call (~3-8s) instead of one serialized 1500-token JSON
    // dump. Failures degrade per-section.
    let learner_message = if greeting {
        "(session start)".to_string()
    } else {
        message.trim().to_string()
    };

    let tokens_msgs = vec![
        json!({"role": "system", "content": prompts::guided_tokens_prompt(&tln, &native)}),
        json!({"role": "user", "content": format!("Tutor reply to tokenize:\n{reply}")}),
    ];
    let translation_msgs = vec![
        json!({"role": "system", "content": prompts::guided_translation_prompt(&tln, &native)}),
        json!({"role": "user", "content": format!("Tutor reply to translate:\n{reply}")}),
    ];
    let mechanics_msgs = vec![
        json!({"role": "system", "content": prompts::guided_mechanics_prompt(&tln, &cefr, &native, &directives)}),
        json!({"role": "user", "content": format!("Learner message ({} level):\n{}\n\nTutor reply:\n{}", cefr, learner_message, reply)}),
    ];
    let scaffolds_msgs = vec![
        json!({"role": "system", "content": prompts::guided_scaffolds_prompt(&tln, &native, assist_level, &directives)}),
        json!({"role": "user", "content": format!("Learner message:\n{}\n\nTutor reply:\n{}", learner_message, reply)}),
    ];

    let analysis_channel = on_event.clone();
    let reply_for_analysis = reply.clone();
    let app_for_analysis = app.clone();
    let worker_key = settings.openrouter_key.clone();
    let worker_model = settings.openrouter_model.clone();
    tokio::spawn(async move {
        let analysis_started = std::time::Instant::now();

        // Each sub-call runs in its own task and hydrates the UI the moment
        // it lands (AnalysisSection). AnalysisDone at the end remains the
        // authoritative merged state, including per-section degradations —
        // so the slowest call never gates the fastest one.
        let tokens_task = {
            let provider = Provider::openrouter(&worker_key, &worker_model);
            let channel = analysis_channel.clone();
            tokio::spawn(async move {
                let result = provider
                    .structured_validated::<TokensOut, _>(
                        &tokens_msgs,
                        0.1,
                        "TokensOut",
                        false,
                        |t: &TokensOut| {
                            if t.tokens.is_empty() {
                                Some("tokens must not be empty".into())
                            } else if let Some(bad) = t
                                .tokens
                                .iter()
                                .find(|tok| tok.text.chars().count() > 48)
                            {
                                // A "token" spanning a whole sentence means the model
                                // leaked reasoning into content instead of splitting.
                                Some(format!(
                                    "each token must be ONE word with its punctuation attached \
                                     ('{}...' is far too long). Split the reply word by word and \
                                     return only the structured tokenization, no explanations.",
                                    bad.text.chars().take(24).collect::<String>()
                                ))
                            } else {
                                None
                            }
                        },
                    )
                    .await;
                if let Ok(out) = &result {
                    let _ = channel.send(GuidedEvent::AnalysisSection {
                        tokens: Some(out.tokens.clone()),
                        translation: None,
                        mechanics: None,
                        scaffolds: None,
                    });
                }
                result
            })
        };
        let translation_task = {
            let provider = Provider::openrouter(&worker_key, &worker_model);
            let channel = analysis_channel.clone();
            tokio::spawn(async move {
                let result = provider
                    .structured_validated::<TranslationOut, _>(
                        &translation_msgs,
                        0.2,
                        "TranslationOut",
                        false,
                        |t: &TranslationOut| {
                            if t.translation.trim().is_empty() { Some("translation must not be empty".into()) } else { None }
                        },
                    )
                    .await;
                if let Ok(out) = &result {
                    let _ = channel.send(GuidedEvent::AnalysisSection {
                        tokens: None,
                        translation: Some(out.translation.clone()),
                        mechanics: None,
                        scaffolds: None,
                    });
                }
                result
            })
        };
        let mechanics_task = {
            let provider = Provider::openrouter(&worker_key, &worker_model);
            let channel = analysis_channel.clone();
            tokio::spawn(async move {
                let result = provider
                    .structured_validated::<MechanicsOut, _>(
                        &mechanics_msgs,
                        0.4,
                        "MechanicsOut",
                        false,
                        |m: &MechanicsOut| {
                            if m.mechanics.is_empty() { Some("mechanics must not be empty - every reply teaches something".into()) } else { None }
                        },
                    )
                    .await;
                if let Ok(out) = &result {
                    let _ = channel.send(GuidedEvent::AnalysisSection {
                        tokens: None,
                        translation: None,
                        mechanics: Some(out.mechanics.clone()),
                        scaffolds: None,
                    });
                }
                result
            })
        };
        let scaffolds_task = {
            let provider = Provider::openrouter(&worker_key, &worker_model);
            let channel = analysis_channel.clone();
            tokio::spawn(async move {
                let result = provider
                    .structured_validated::<ScaffoldsOut, _>(
                        &scaffolds_msgs,
                        0.6,
                        "ScaffoldsOut",
                        false,
                        |sc: &ScaffoldsOut| {
                            if sc.replies.is_empty()
                                || sc.frames.is_empty()
                                || sc.starters.is_empty()
                            {
                                Some("all three scaffold lists must be populated".into())
                            } else {
                                None
                            }
                        },
                    )
                    .await;
                if let Ok(out) = &result {
                    let _ = channel.send(GuidedEvent::AnalysisSection {
                        tokens: None,
                        translation: None,
                        mechanics: None,
                        scaffolds: Some(Scaffolds {
                            replies: out.replies.clone(),
                            frames: out.frames.clone(),
                            starters: out.starters.clone(),
                        }),
                    });
                }
                result
            })
        };

        let (tokens_out, translation_out, mechanics_out, scaffolds_out) = (
            tokens_task
                .await
                .unwrap_or_else(|e| Err(format!("tokens task panicked: {e}"))),
            translation_task
                .await
                .unwrap_or_else(|e| Err(format!("translation task panicked: {e}"))),
            mechanics_task
                .await
                .unwrap_or_else(|e| Err(format!("mechanics task panicked: {e}"))),
            scaffolds_task
                .await
                .unwrap_or_else(|e| Err(format!("scaffolds task panicked: {e}"))),
        );

        // Per-section degradation: a failed sub-call costs its section only.
        let mut failures: Vec<String> = Vec::new();
        let tokens = match tokens_out {
            Ok(t) => t.tokens,
            Err(e) => {
                failures.push(format!("tokens: {e}"));
                Vec::new()
            }
        };
        let translation = match translation_out {
            Ok(t) => Some(t.translation),
            Err(e) => {
                failures.push(format!("translation: {e}"));
                None
            }
        };
        let mechanics = match mechanics_out {
            Ok(m) => m.mechanics,
            Err(e) => {
                failures.push(format!("mechanics: {e}"));
                Vec::new()
            }
        };
        let scaffolds = match scaffolds_out {
            Ok(sc) => Scaffolds {
                replies: sc.replies,
                frames: sc.frames,
                starters: sc.starters,
            },
            Err(e) => {
                failures.push(format!("scaffolds: {e}"));
                Scaffolds {
                    replies: Vec::new(),
                    frames: Vec::new(),
                    starters: Vec::new(),
                }
            }
        };

        if failures.is_empty() {
            info!(
                "[cmd] guided analysis done in {:.1}s: tokens={} mechanics={}",
                analysis_started.elapsed().as_secs_f32(),
                tokens.len(),
                mechanics.len(),
            );
        } else {
            warn!(
                "[cmd] guided analysis partially degraded in {:.1}s: {}",
                analysis_started.elapsed().as_secs_f32(),
                failures.join("; "),
            );
        }

        // Record taught mechanics so future analyses never repeat them.
        {
            let state = app_for_analysis.state::<AppState>();
            let mut recent = state
                .recent_mechanics
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            for mech in &mechanics {
                recent.push(mech.title.clone());
            }
            let len = recent.len();
            if len > 20 {
                recent.drain(0..len - 20);
            }
        }

        let _ = analysis_channel.send(GuidedEvent::AnalysisDone {
            turn: GuidedTurnResult {
                reply: reply_for_analysis,
                translation,
                tokens,
                mechanics,
                scaffolds,
                errors: failures,
            },
        });
    });

    Ok(reply)
}

// ─── Stories ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct StoryToken {
    /// The exact word from the story, punctuation attached.
    pub text: String,
    /// Short native-language meaning of the word in this context.
    #[serde(default)]
    pub gloss: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct StoryParagraph {
    /// The paragraph split word by word, in order. Each token is an object.
    pub tokens: Vec<StoryToken>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct StoryResponse {
    /// Short story title in the target language.
    pub title: String,
    /// The story as 1-4 paragraphs, in order.
    #[schemars(length(min = 1, max = 4))]
    pub paragraphs: Vec<StoryParagraph>,
}

impl StoryResponse {
    fn validate(&self) -> Option<String> {
        let glossed = self
            .paragraphs
            .iter()
            .flat_map(|p| p.tokens.iter())
            .filter(|t| t.gloss.is_some())
            .count();
        if glossed == 0 {
            Some(
                "at least some tokens must carry a native-language gloss — the reader \
                 relies on them for tap-to-translate"
                    .into(),
            )
        } else {
            None
        }
    }
}

#[tauri::command]
pub async fn generate_story(
    state: State<'_, AppState>,
    level: String,
) -> Result<StoryResponse, String> {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if settings.openrouter_key.is_empty() {
        return Err("No OpenRouter API key configured. Open Settings and add your key.".into());
    }
    if !matches!(level.as_str(), "beginner" | "intermediate" | "advanced") {
        warn!("[cmd] generate_story rejected: unknown level {level}");
        return Err(format!("Unknown level: {level}"));
    }
    let started = std::time::Instant::now();
    info!("[cmd] generate_story: level={level} target={}", settings.target_language);

    let target = settings.target_language.clone();
    let tln = language_display(&target);
    let native = native_display(&settings.native_language);
    let cefr = prompts::resolve_cefr(&level);

    let system = prompts::story_prompt(&tln, cefr, &native, &level, overlay(&target));
    let messages = vec![
        json!({"role": "system", "content": system}),
        json!({
            "role": "user",
            "content": "Write a new story. Vary the topic — do not repeat common everyday scenarios you have used recently."
        }),
    ];

    let provider = Provider::openrouter(&settings.openrouter_key, &settings.openrouter_model);
    provider
        .structured_validated::<StoryResponse, _>(
            &messages,
            0.7,
            "StoryResponse",
            false, // workers never think
            |st| st.validate(),
        )
        .await
        .map(|story| {
            let tokens: usize = story.paragraphs.iter().map(|p| p.tokens.len()).sum();
            info!(
                "[cmd] generate_story done in {:.1}s: paragraphs={} tokens={}",
                started.elapsed().as_secs_f32(),
                story.paragraphs.len(),
                tokens,
            );
            story
        })
        .map_err(|e| {
            error!(
                "[cmd] generate_story failed after {:.1}s: {e}",
                started.elapsed().as_secs_f32()
            );
            format!("story generation failed: {e}")
        })
}

// ─── Observer documents ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ObserverDocuments {
    pub plan: observer::TeachingPlan,
    pub profile: observer::Profile,
}

#[tauri::command]
pub fn get_plan(state: State<'_, AppState>) -> Result<ObserverDocuments, String> {
    Ok(ObserverDocuments {
        plan: state.plan.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        profile: state
            .profile
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone(),
    })
}

// ─── STT (Groq Whisper) ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn transcribe_audio(
    state: State<'_, AppState>,
    audio_base64: String,
) -> Result<String, String> {
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if settings.groq_key.is_empty() {
        warn!("[cmd] transcribe_audio rejected: no Groq key");
        return Err("No Groq API key configured. Open Settings and add your key.".into());
    }

    let started = std::time::Instant::now();
    let audio = base64::engine::general_purpose::STANDARD
        .decode(&audio_base64)
        .map_err(|e| format!("invalid audio data: {e}"))?;
    info!(
        "[cmd] transcribe_audio: {} bytes, target={}",
        audio.len(),
        settings.target_language
    );

    let target = settings.target_language.clone();
    let language = iso639(&target);
    let file_part = reqwest::multipart::Part::bytes(audio)
        .file_name("audio.webm")
        .mime_str("audio/webm")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-large-v3-turbo")
        .text("language", language)
        .text("response_format", "json")
        .part("file", file_part);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(settings.groq_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("transcription request failed: {e}"))?;

    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("invalid transcription response: {e}"))?;
    if !status.is_success() {
        error!("[cmd] transcription API error {status}: {}", body.to_string());
        return Err(format!(
            "transcription API error {status}: {}",
            body.to_string()
        ));
    }
    let text = body["text"].as_str().unwrap_or_default().trim().to_string();
    info!(
        "[cmd] transcribe_audio done in {:.1}s: {:?}",
        started.elapsed().as_secs_f32(),
        text
    );
    Ok(text)
}
