use serde::{Deserialize, Serialize};
use std::path::Path;

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
    #[serde(default)]
    pub observer_model: Option<String>,
}

fn default_model() -> String {
    // Fast non-thinking worker: strong multilingual quality, deep pool
    // (no shared-pool 429s), honors reasoning-disable, handles json_schema.
    "deepseek/deepseek-v4-flash-0731".into()
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
            observer_model: None,
        }
    }
}

fn settings_path(dir: &Path) -> std::path::PathBuf {
    dir.join("settings.json")
}

pub fn load_or_create(dir: &Path) -> Settings {
    let path = settings_path(dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => {
            let defaults = Settings::default();
            persist(dir, &defaults);
            defaults
        }
    }
}

pub fn persist(dir: &Path, settings: &Settings) {
    let path = settings_path(dir);
    if let Ok(raw) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(path, raw);
    }
}
