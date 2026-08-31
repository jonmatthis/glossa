/// Language registry — the SINGLE source of truth. Every language here is
/// fully symmetric: usable as the TARGET (AI conversation + analysis
/// language) or the NATIVE (learner's own language + app UI language, see
/// lib/i18n.ts). All pairwise combinations are supported by construction:
/// prompts take target/native names from this table, STT uses `base` for
/// Whisper language codes, and overlays carry per-target guidance.
///
/// `romanization` carries the romanization scheme for non-Latin scripts
/// (ALA-LC for Arabic); the AI returns a romanized form alongside the
/// native script and the UI displays both. Latin-script languages use None.
///
/// Ladder (docs/future-work.md): a language only enters the registry once
/// its interaction quirks are handled (space-delimited text, accented input,
/// RTL, segmentation). Current rungs: en-US, fr-FR, es-ES, ar-Levantine.
/// Next: Mandarin (segmentation + tones).
pub struct Language {
    /// BCP-47 code — used as `target_language` in settings.
    pub code: &'static str,
    /// ISO 639-1 base — used as `native_language` in settings and for STT.
    pub base: &'static str,
    /// Display name (English label, region-qualified).
    pub name: &'static str,
    /// The language's own name, as its speakers write it.
    pub endonym: &'static str,
    /// Text direction for UI rendering.
    pub direction: &'static str,
    /// Romanization scheme for non-Latin scripts (ALA-LC, PINYIN, ...), or
    /// None for Latin-script languages.
    pub romanization: Option<&'static str>,
    /// Target-language guidance injected into every prompt when this
    /// language is the target.
    pub overlay: &'static str,
}

pub const LANGUAGES: &[Language] = &[
    Language {
        code: "en-US",
        base: "en",
        name: "English (US)",
        endonym: "English",
        direction: "ltr",
        romanization: None,
        overlay: "Language-specific guidance:\n- Use American English spelling, vocabulary, and idiom consistently (color, organize, elevator).\n- Pay close attention to word order, verb tenses, and preposition usage.\n- Avoid British-only vocabulary unless explicitly comparing variants.\n- Keep register natural: contractions (I'm, don't) are fine and expected in casual conversation.",
    },
    Language {
        code: "fr-FR",
        base: "fr",
        name: "French",
        endonym: "Français",
        direction: "ltr",
        romanization: None,
        overlay: "Language-specific guidance:\n- Use standard French as spoken in France consistently.\n- Pay close attention to accents (é, è, ê, ç), elision (j'ai, l'ami), gender, and number agreement.\n- Use tu or vous consistently according to the context and learner level.\n- Avoid Canadian/Belgian/Swiss regionalisms unless explicitly comparing them.\n- Natural French phrasing: contractions (au, du, aux) and liaison where appropriate.",
    },
    Language {
        code: "es-ES",
        base: "es",
        name: "Spanish (Spain)",
        endonym: "Español",
        direction: "ltr",
        romanization: None,
        overlay: "Language-specific guidance:\n- Use Peninsular Spanish from Spain consistently.\n- Prefer Spain usage, including vosotros for informal plural address when appropriate.\n- Avoid voseo and Latin American-only vocabulary unless explicitly comparing variants.\n- Pay close attention to accents, gender, number agreement, and natural Spain Spanish phrasing.",
    },
    Language {
        code: "ar-LE",
        base: "ar",
        name: "Arabic (Levantine)",
        endonym: "العربية",
        direction: "rtl",
        romanization: Some("ALA-LC"),
        overlay: "Language-specific guidance:\n- Use Levantine Arabic (Lebanon/Syria/Jordan/Palestine) as understood across the region.\n- Write in Arabic script with natural spelling; do not write in Latin characters.\n- Modern Standard Arabic vocabulary is acceptable when no Levantine equivalent exists, but keep grammar and phrasing Levantine.\n- Pay attention to root-and-pattern morphology: forms I-X change meaning systematically.\n- gender and number agreement are mandatory; the dual form exists alongside singular and plural.\n- Do not vocalize with full diacritics (tashkeel); write as natives type, unvocalized.",
    },
];

/// Display name for a language code — exact BCP-47 match first, then base
/// match, else the code itself.
pub fn language_display(code: &str) -> String {
    let base = code.split('-').next().unwrap_or(code);
    LANGUAGES
        .iter()
        .find(|l| l.code == code || l.base == base)
        .map(|l| l.name.to_string())
        .unwrap_or_else(|| code.to_string())
}

/// Endonym for a base language code ("en" -> "English").
pub fn native_display(base: &str) -> String {
    let base = base.split('-').next().unwrap_or(base);
    LANGUAGES
        .iter()
        .find(|l| l.base == base)
        .map(|l| l.endonym.to_string())
        .unwrap_or_else(|| base.to_string())
}

/// Convert a BCP-47 target language to the ISO 639-1 code used by STT APIs.
pub fn iso639(code: &str) -> String {
    code.split('-').next().unwrap_or(code).to_lowercase()
}

/// Target-language guidance injected into every prompt when this language
/// is the target.
pub fn overlay(code: &str) -> &'static str {
    LANGUAGES
        .iter()
        .find(|l| l.code == code)
        .map(|l| l.overlay)
        .unwrap_or("")
}
