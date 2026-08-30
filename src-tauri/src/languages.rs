/// Language support. The ladder (see glossa-docs/docs/future-work.md):
/// Spanish first, then Arabic (RTL), then Mandarin (segmentation), then the
/// rest by interpolation. A target language may only appear here once its
/// mechanical analysis layer (dictionary/lemmatizer) exists — AI-only
/// "support" is how we ended up with ten half-supported languages.
pub const TARGET_LANGUAGES: &[(&str, &str)] = &[
    ("es-ES", "Spanish (Spain)"),
];

/// The learner's own language — display names for the Settings selector.
/// Glosses/explanations are generated in this language by the AI layers.
pub const NATIVE_LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("it", "Italian"),
    ("pt", "Portuguese"),
    ("de", "German"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("zh", "Chinese"),
];

pub fn language_display(code: &str) -> String {
    TARGET_LANGUAGES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, n)| n.to_string())
        .unwrap_or_else(|| code.to_string())
}

pub fn native_display(code: &str) -> String {
    NATIVE_LANGUAGES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, n)| n.to_string())
        .unwrap_or_else(|| code.to_string())
}

/// Convert a BCP-47 target language to the ISO 639-1 code used by STT APIs.
pub fn iso639(code: &str) -> String {
    code.split('-').next().unwrap_or(code).to_lowercase()
}

pub fn overlay(code: &str) -> &'static str {
    match code {
        "es-ES" => {
            "Language-specific guidance:\n- Use Peninsular Spanish from Spain consistently.\n- Prefer Spain usage, including vosotros for informal plural address when appropriate.\n- Avoid voseo and Latin American-only vocabulary unless explicitly comparing variants.\n- Pay close attention to accents, gender, number agreement, and natural Spain Spanish phrasing."
        }
        _ => "",
    }
}
