//! The Observer: a reasoning-model pass that runs in the background and
//! maintains two small, learner-visible documents — the session TeachingPlan
//! and the cross-session Profile. It never talks to the learner; its only
//! job is keeping the documents accurate so the fast worker prompts can
//! steer the conversation.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

use crate::ai::Provider;

// ─── Documents ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RecurringError {
    /// The learner's actual erroneous phrasing.
    pub error: String,
    /// The correct target-language form.
    pub correction: String,
    /// How many times it has been observed.
    #[serde(default)]
    pub seen_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TaughtMechanic {
    /// The grammar mechanic covered by an analysis card.
    pub mechanic: String,
    /// The conversation turn it was last taught on.
    #[serde(default)]
    pub last_seen_turn: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TeachingPlan {
    /// 1-3 grammar structures / skills to steer toward right now.
    #[serde(default)]
    pub session_focus: Vec<String>,
    /// The recast queue: learner errors worth gently correcting.
    #[serde(default)]
    pub recurring_errors: Vec<RecurringError>,
    /// Vocabulary worth recycling in upcoming replies.
    #[serde(default)]
    pub vocab_recycle: Vec<String>,
    /// Structures/topics to avoid (overload guard).
    #[serde(default)]
    pub avoid: Vec<String>,
    /// Learner interests worth asking about.
    #[serde(default)]
    pub learner_interests: Vec<String>,
    /// One-phrase read of the learner's energy this session.
    #[serde(default)]
    pub energy_read: String,
    /// Max recasts allowed per reply (correction budget).
    #[serde(default = "default_correction_budget")]
    pub correction_budget: u32,
    /// Mechanics already covered — workers must not re-teach these.
    #[serde(default)]
    pub taught_ledger: Vec<TaughtMechanic>,
}

fn default_correction_budget() -> u32 {
    1
}

impl Default for TeachingPlan {
    /// Bootstraps the very first session: a generic, language-neutral
    /// beginner plan so the learner never sees an empty tutor.
    fn default() -> Self {
        Self {
            session_focus: vec![
                "Everyday greetings and simple present-tense exchanges".into(),
                "Survival phrases — asking to repeat, saying you don't understand".into(),
            ],
            recurring_errors: Vec::new(),
            vocab_recycle: Vec::new(),
            avoid: vec![
                "Past tenses — until the learner shows they are ready".into(),
                "Very long tutor turns — keep replies short and warm".into(),
            ],
            learner_interests: Vec::new(),
            energy_read: "First session — warming up".into(),
            correction_budget: default_correction_budget(),
            taught_ledger: Vec::new(),
        }
    }
}

impl TeachingPlan {
    pub fn validate(&self) -> Option<String> {
        None // the plan is advisory; an empty plan is a valid plan
    }
}

/// Durable, cross-session knowledge about the learner.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[derive(Default)]
pub struct Profile {
    /// 2-3 sentence summary of who the learner is and where they are.
    #[serde(default)]
    pub about: String,
    /// Level read over time (CEFR-ish, with evidence).
    #[serde(default)]
    pub level_notes: String,
    /// Things the learner does well.
    #[serde(default)]
    pub strengths: Vec<String>,
    /// Things the learner struggles with.
    #[serde(default)]
    pub weaknesses: Vec<String>,
    /// Durable interests (conversation fuel across sessions).
    #[serde(default)]
    pub interests: Vec<String>,
    /// Long-term error history worth watching across sessions.
    #[serde(default)]
    pub long_term_errors: Vec<RecurringError>,
    /// How many sessions completed.
    #[serde(default)]
    pub sessions: u32,
}


#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ObserverOutput {
    /// The rewritten session TeachingPlan (full replacement).
    pub plan: TeachingPlan,
    /// The rewritten learner Profile (full replacement).
    pub profile: Profile,
}

impl ObserverOutput {
    pub fn validate(&self) -> Option<String> {
        None
    }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/// Load one document. A missing file is a fresh install (fine). A CORRUPT
/// file must never be silently discarded: move it aside and scream.
fn load_document<T: serde::de::DeserializeOwned + Default>(dir: &Path, name: &str) -> T {
    let path = dir.join(name);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return T::default(), // fresh install — nothing to load
    };
    match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            let bad = dir.join(format!("{name}.bad"));
            let _ = std::fs::rename(&path, &bad);
            log::error!(
                "{name} was CORRUPT ({e}) - moved to {}. Starting fresh; the old file is preserved.",
                bad.display()
            );
            T::default()
        }
    }
}

pub fn load_documents(dir: &Path) -> (TeachingPlan, Profile) {
    (
        load_document(dir, "plan.json"),
        load_document(dir, "profile.json"),
    )
}

pub fn persist_documents(dir: &Path, plan: &TeachingPlan, profile: &Profile) {
    if let Ok(raw) = serde_json::to_string_pretty(plan) {
        if let Err(e) = std::fs::write(dir.join("plan.json"), raw) {
            log::error!("FAILED to persist plan.json: {e} - teaching plan will be lost");
        }
    }
    if let Ok(raw) = serde_json::to_string_pretty(profile) {
        if let Err(e) = std::fs::write(dir.join("profile.json"), raw) {
            log::error!("FAILED to persist profile.json: {e} - profile will be lost");
        }
    }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

/// Compact advisory block injected into the fast worker prompts.
pub fn directives_block(plan: &TeachingPlan, recent_mechanics: &[String]) -> String {
    let mut lines = vec!["TEACHING PLAN (advisory — steer gently, keep the conversation natural):".to_string()];
    if !plan.session_focus.is_empty() {
        lines.push(format!("- Practice focus: {}", plan.session_focus.join("; ")));
    }
    if !plan.recurring_errors.is_empty() {
        let errors: Vec<String> = plan
            .recurring_errors
            .iter()
            .map(|e| format!("\"{}\" → \"{}\" (×{})", e.error, e.correction, e.seen_count))
            .collect();
        lines.push(format!(
            "- Recast at most {} error(s) this reply, highest value first: {}",
            plan.correction_budget,
            errors.join("; ")
        ));
    } else {
        lines.push("- No errors to recast right now.".to_string());
    }
    if !plan.vocab_recycle.is_empty() {
        lines.push(format!("- Recycle vocabulary: {}", plan.vocab_recycle.join(", ")));
    }
    if !plan.avoid.is_empty() {
        lines.push(format!("- Avoid: {}", plan.avoid.join("; ")));
    }
    if !plan.learner_interests.is_empty() {
        lines.push(format!(
            "- Learner interests you can ask about: {}",
            plan.learner_interests.join(", ")
        ));
    }
    if !plan.energy_read.is_empty() {
        lines.push(format!("- Learner energy: {}", plan.energy_read));
    }
    // Anti-repetition: everything already covered by an analysis card, from
    // both the observer's ledger and the cards fired in recent turns.
    let mut taught: Vec<String> = plan.taught_ledger.iter().map(|t| t.mechanic.clone()).collect();
    for m in recent_mechanics {
        if !taught.contains(m) {
            taught.push(m.clone());
        }
    }
    if !taught.is_empty() {
        lines.push(format!(
            "- ALREADY TAUGHT (do NOT re-teach; pick something new unless the learner clearly needs review): {}",
            taught.join(" | ")
        ));
    }
    lines.join("\n")
}

pub fn observer_system_prompt(target_language_name: &str) -> String {
    format!(
        "You are the teaching coordinator for an immersive {tln} tutoring session.\n\
         You NEVER talk to the learner. Your only job: keep two small documents\n\
         accurate and useful so the fast tutor-workers can teach better.\n\n\
         You will receive: the conversation transcript, the current Teaching Plan,\n\
         the learner Profile, and the grammar cards recently taught.\n\n\
         Rewrite BOTH documents based on the latest evidence:\n\
         - TeachingPlan: what to practice next (1-3 items max), the recurring-error\n\
           recast queue (with seen counts), vocabulary worth recycling, what to avoid\n\
           (overload guard), learner interests worth asking about, a one-phrase energy\n\
           read, the correction budget (1-2), and the taught-ledger (mechanics already\n\
           covered — workers must not re-teach them).\n\
         - Profile: durable facts that persist across sessions — a 2-3 sentence 'about',\n\
           level notes with evidence, strengths, weaknesses, durable interests, and the\n\
           long-term error history.\n\n\
         Rules:\n\
         - ADVISORY ONLY: workers steer gently. Your documents must keep the\n\
           conversation natural — never lecture-y, never a lesson plan.\n\
         - Be concrete: cite actual words the learner actually said, not generic advice.\n\
         - Keep it SMALL: these documents are injected into fast worker prompts.\n\
         - Full replacement: emit the complete documents, not diffs.\n\
         - The learner can see these documents. Write them respectfully and usefully.",
        tln = target_language_name,
    )
}

pub fn observer_user_message(
    transcript: &str,
    plan: &TeachingPlan,
    profile: &Profile,
    recent_mechanics: &[String],
) -> Value {
    json!({
        "role": "user",
        "content": format!(
            "CONVERSATION TRANSCRIPT:\n{transcript}\n\n\
             RECENTLY TAUGHT (do not re-teach): {mechanics}\n\n\
             CURRENT TEACHING PLAN:\n{plan}\n\n\
             CURRENT PROFILE:\n{profile}\n\n\
             Rewrite both documents now.",
            transcript = transcript,
            mechanics = if recent_mechanics.is_empty() { "(none)".to_string() } else { recent_mechanics.join("; ") },
            plan = serde_json::to_string_pretty(plan).unwrap_or_default(),
            profile = serde_json::to_string_pretty(profile).unwrap_or_default(),
        )
    })
}

/// Run one observer pass (reasoning model — this is where thinking earns its keep).
pub async fn run_observer(
    provider: &Provider,
    target_language_name: &str,
    transcript: &str,
    plan: &TeachingPlan,
    profile: &Profile,
    recent_mechanics: &[String],
) -> Result<ObserverOutput, String> {
    let messages = vec![
        json!({"role": "system", "content": observer_system_prompt(target_language_name)}),
        observer_user_message(transcript, plan, profile, recent_mechanics),
    ];
    provider
        .structured_validated::<ObserverOutput, _>(
            &messages,
            0.4,
            "ObserverOutput",
            true, // the observer is the reasoning model — let it think
            |o| o.validate(),
        )
        .await
        .map_err(|e| format!("observer failed: {e}"))
}
