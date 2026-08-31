/// Language support. The ladder (see glossa-docs/docs/future-work.md):
/// Spanish first, then French (same text mechanics, new native pairings),
/// then Arabic (RTL), then Mandarin (segmentation), then the rest by
/// interpolation. A target language may only appear here once its
/// mechanical analysis layer (dictionary/lemmatizer) exists — AI-only
/// "support" is how we ended up with ten half-supported languages.
///
/// The NATIVE language doubles as the app's UI language (lib/i18n.ts):
/// buttons, labels, and chrome render in the learner's own language, while
/// the TARGET language drives the AI conversation and analysis.
pub const TARGET_LANGUAGES: &[(&str, &str)] = &[
    ("en-US", "English (US)"),
    ("fr-FR", "French"),
    ("es-ES", "Spanish (Spain)"),
];

/// The learner's own language — display names for the Settings selector.
/// Glosses/explanations are generated in this language by the AI layers,
/// and it doubles as the app's UI language (lib/i18n.ts).
pub const NATIVE_LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("fr", "French"),
    ("es", "Spanish"),
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
        "en-US" => {
            "Language-specific guidance:\n- Use American English spelling, vocabulary, and idiom consistently (color, organize, elevator).\n- Pay close attention to word order, verb tenses, and preposition usage.\n- Avoid British-only vocabulary unless explicitly comparing variants.\n- Keep register natural: contractions (I'm, don't) are fine and expected in casual conversation."
        }
        "es-ES" => {
            "Language-specific guidance:\n- Use Peninsular Spanish from Spain consistently.\n- Prefer Spain usage, including vosotros for informal plural address when appropriate.\n- Avoid voseo and Latin American-only vocabulary unless explicitly comparing variants.\n- Pay close attention to accents, gender, number agreement, and natural Spain Spanish phrasing."
        }
        "fr-FR" => {
            "Language-specific guidance:\n- Use standard French as spoken in France consistently.\n- Pay close attention to accents (é, è, ê, ç), elision (j'ai, l'ami), gender, and number agreement.\n- Use tu or vous consistently according to the context and learner level.\n- Avoid Canadian/Belgian/Swiss regionalisms unless explicitly comparing them.\n- Natural French phrasing: contractions (au, du, aux) and liaison where appropriate."
        }
        _ => "",
    }
}
