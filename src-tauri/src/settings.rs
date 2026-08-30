use serde::{Deserialize, Serialize};
use std::path::Path;

/// Configurable keyboard shortcuts. Stored as normalized combo strings
/// ("ctrl+m") — see lib/keyboard.ts for the normalization dialect.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Shortcuts {
    #[serde(default = "default_sc_mic")]
    pub mic: String,
    #[serde(default = "default_sc_speak")]
    pub speak: String,
    #[serde(default = "default_sc_panel")]
    pub panel: String,
    #[serde(default = "default_sc_settings")]
    pub settings: String,
}

fn default_sc_mic() -> String {
    "ctrl+m".into()
}
fn default_sc_speak() -> String {
    "ctrl+l".into()
}
fn default_sc_panel() -> String {
    "ctrl+b".into()
}
fn default_sc_settings() -> String {
    "ctrl+,".into()
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            mic: default_sc_mic(),
            speak: default_sc_speak(),
            panel: default_sc_panel(),
            settings: default_sc_settings(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub openrouter_key: String,
    #[serde(default)]
    pub groq_key: String,
    #[serde(default = "default_model")]
    pub openrouter_model: String,
    #[serde(default = "default_target")]
    pub target_language: String,
    #[serde(default = "default_native")]
    pub native_language: String,
    #[serde(default)]
    pub microphone_device_id: Option<String>,
    /// Speak each tutor reply aloud via OS voices (Web Speech API).
    #[serde(default)]
    pub auto_speak: bool,
    /// Send the speech transcription immediately instead of filling the composer.
    #[serde(default)]
    pub auto_send: bool,
    /// Configurable keyboard shortcuts.
    #[serde(default)]
    pub shortcuts: Shortcuts,
    #[serde(default)]
    pub observer_model: Option<String>,
}

fn default_model() -> String {
    // Worker default: gemini-2.5-flash — 6/6 on the model bench (all analysis
    // calls + story, zero retries) plus a full day of live use, zero schema
    // failures. Structured output is decoder-enforced; ~$0.30/$2.50 per M
    // tokens.
    //
    // Demoted candidates, all verified against the real call path:
    // - deepseek-v4-flash: repetition loops, wrapper-shape failures.
    // - gemini-3.1-flash-lite: fast/cheap but failed story gloss validation.
    // - gemini-3.5-flash-lite: reasoning mandatory — cannot serve as a fast
    //   worker (fails loudly, by design).
    // - gpt-5-nano: requires strict-dialect schemas (additionalProperties:
    //   false + all-properties-required on every nested object). Serving it
    //   would need a schema normalizer — judged not worth the complexity
    //   for now. Would also need temperature omitted + reasoning
    //   effort:minimal (both handled by apply_dialect/reasoning_off).
    "google/gemini-2.5-flash".into()
}

/// Prior worker defaults. Stored settings migrate off these on load —
/// each was demoted after real structured-output failures or superseded.
const LEGACY_DEFAULT_MODELS: &[&str] = &[
    "deepseek/deepseek-v4-flash-0731",
    "google/gemini-3.1-flash-lite",
    "openai/gpt-5-nano",
];

fn migrate(settings: &mut Settings) {
    if LEGACY_DEFAULT_MODELS.contains(&settings.openrouter_model.as_str()) {
        log::info!(
            "migrating worker model: {} -> {}",
            settings.openrouter_model,
            default_model()
        );
        settings.openrouter_model = default_model();
    }
}

/// The observer default THINKS — reasoning is where its value comes from.
pub fn default_observer_model() -> String {
    "z-ai/glm-5.3-flash".into()
}

fn default_target() -> String {
    "es-ES".into()
}

fn default_native() -> String {
    "en".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            openrouter_key: String::new(),
            groq_key: String::new(),
            openrouter_model: default_model(),
            target_language: default_target(),
            native_language: default_native(),
            microphone_device_id: None,
            auto_speak: false,
            auto_send: false,
            shortcuts: Shortcuts::default(),
            observer_model: None,
        }
    }
}

/// Mask a secret for display/IPC: keep only the last 4 chars. A masked
/// value round-trips safely — save_settings treats an unchanged mask as
/// "keep the stored key".
pub fn mask(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let tail: String = key
        .chars()
        .skip(key.chars().count().saturating_sub(4))
        .collect();
    format!("••••{tail}")
}

impl Settings {
    /// IPC-safe copy: secrets replaced by their masked form.
    pub fn masked(&self) -> Settings {
        let mut s = self.clone();
        s.openrouter_key = mask(&self.openrouter_key);
        s.groq_key = mask(&self.groq_key);
        s
    }
}

fn settings_path(dir: &Path) -> std::path::PathBuf {
    dir.join("settings.json")
}

pub fn load_or_create(dir: &Path) -> Settings {
    let path = settings_path(dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
            Ok(mut s) => {
                migrate(&mut s);
                s
            }
            Err(e) => {
                // A corrupt settings file must NEVER be silently replaced —
                // that would wipe the user's API keys without a word. Move it
                // aside and scream.
                let bad = dir.join("settings.json.bad");
                let _ = std::fs::rename(&path, &bad);
                log::error!(
                    "settings.json was CORRUPT ({e}) - moved to {} and starting fresh. \
                     API keys were NOT loaded; re-enter them in Settings.",
                    bad.display()
                );
                let defaults = Settings::default();
                if let Err(e) = persist(dir, &defaults) {
                    log::error!("could not write fresh settings.json: {e}");
                }
                defaults
            }
        },
        Err(_) => {
            let defaults = Settings::default();
            if let Err(e) = persist(dir, &defaults) {
                log::error!("could not write initial settings.json: {e}");
            }
            defaults
        }
    }
}

/// Persist settings. Returns an error instead of swallowing IO failures —
/// a failed save means the user's keys are NOT on disk and they must know.
pub fn persist(dir: &Path, settings: &Settings) -> Result<(), String> {
    let path = settings_path(dir);
    serde_json::to_string_pretty(settings)
        .map_err(|e| format!("settings serialization failed: {e}"))
        .and_then(|raw| {
            std::fs::write(path, raw).map_err(|e| format!("settings write failed: {e}"))
        })
}

#[cfg(test)]
mod tests {
use super::*;

#[test]
fn mask_hides_everything_but_tail() {
    assert_eq!(mask(""), "");
    let m = mask("sk-or-v1-abcd1234");
    assert!(m.starts_with("\u{2022}\u{2022}\u{2022}\u{2022}"));
    assert!(m.ends_with("1234"));
    assert!(!m.contains("sk-or"));
}

#[test]
fn migrate_moves_legacy_defaults_to_current() {
    for legacy in LEGACY_DEFAULT_MODELS {
        let mut s = Settings::default();
        s.openrouter_model = legacy.to_string();
        migrate(&mut s);
        assert_eq!(s.openrouter_model, default_model());
    }
    // The current default is stable under migration.
    let mut cur = Settings::default();
    migrate(&mut cur);
    assert_eq!(cur.openrouter_model, default_model());
}
}
