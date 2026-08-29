/// Supported target languages (BCP-47) and the per-variant prompt overlays,
/// ported from the FreeLingo prompt library.

pub const TARGET_LANGUAGES: &[(&str, &str)] = &[
    ("en-GB", "English (UK)"),
    ("en-US", "English (US)"),
    ("es-ES", "Spanish (Spain)"),
    ("fr-FR", "French"),
    ("it-IT", "Italian"),
    ("pt-PT", "Portuguese (Portugal)"),
    ("de-DE", "German"),
    ("ja-JP", "Japanese"),
    ("ko-KR", "Korean"),
    ("zh-CN", "Chinese (Simplified)"),
];

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
        "en-US" => {
            "Language-specific guidance:\n- Use American English spelling, vocabulary, punctuation, and idiom consistently.\n- Prefer US forms such as color, center, organize, apartment, elevator, truck, and vacation.\n- Avoid British-only spelling and vocabulary unless explicitly comparing variants."
        }
        "en-GB" => {
            "Language-specific guidance:\n- Use British English spelling, vocabulary, punctuation, and idiom consistently.\n- Prefer UK forms such as colour, centre, organise, flat, lift, lorry, and holiday.\n- Avoid American-only spelling and vocabulary unless explicitly comparing variants."
        }
        "es-ES" => {
            "Language-specific guidance:\n- Use Peninsular Spanish from Spain consistently.\n- Prefer Spain usage, including vosotros for informal plural address when appropriate.\n- Avoid voseo and Latin American-only vocabulary unless explicitly comparing variants.\n- Pay close attention to accents, gender, number agreement, and natural Spain Spanish phrasing."
        }
        "it-IT" => {
            "Language-specific guidance:\n- Use standard Italian as used in Italy consistently.\n- Pay close attention to articles, gender, number agreement, articulated prepositions, and clitic pronouns.\n- Use tu or Lei consistently according to the context and learner level.\n- Avoid strong regionalisms unless explicitly teaching or comparing them."
        }
        "pt-PT" => {
            "Language-specific guidance:\n- Use European Portuguese from Portugal consistently.\n- Avoid Brazilian Portuguese vocabulary, syntax, and pronoun placement unless explicitly comparing variants.\n- Prefer Portugal usage such as telemóvel, autocarro, pequeno-almoço, and comboio.\n- Pay close attention to European Portuguese clitic placement, contractions, accents, and register."
        }
        "fr-FR" => {
            "Language-specific guidance:\n- Use standard French from France consistently.\n- Pay close attention to accents, elision, contractions, gender, number agreement, and register.\n- Use tu or vous consistently according to the context and learner level.\n- Avoid Canadian or other regional French variants unless explicitly comparing them."
        }
        "de-DE" => {
            "Language-specific guidance:\n- Use standard German spelling and vocabulary as used in Germany consistently.\n- Pay close attention to noun capitalization, grammatical gender, cases, adjective endings, and verb position.\n- Use du or Sie consistently according to the context and learner level.\n- Avoid Austrian or Swiss variants unless explicitly comparing them."
        }
        "ja-JP" => {
            "Language-specific guidance:\n- Use standard Japanese as used in Japan consistently.\n- Use Japanese script naturally: hiragana, katakana, and level-appropriate kanji. Use romaji only as a short support aid for beginners or when explicitly teaching pronunciation.\n- Pay close attention to particles, politeness level, verb forms, counters, and natural word order.\n- Keep register consistent with the learner level; avoid abrupt shifts between plain and polite style unless teaching the contrast."
        }
        "ko-KR" => {
            "Language-specific guidance:\n- Use standard Korean as used in South Korea consistently.\n- Use Hangul as the primary script. Use romanization only as a short support aid for beginners or when explicitly teaching pronunciation.\n- Pay close attention to particles, speech level, honorifics, verb endings, batchim, and natural Korean phrasing.\n- Avoid North Korean vocabulary, spelling, or usage unless explicitly comparing variants."
        }
        "zh-CN" => {
            "Language-specific guidance:\n- Use Mainland China Standard Mandarin (Putonghua) consistently.\n- Use simplified Chinese characters. Use pinyin with tone marks only as support for pronunciation or beginner scaffolding, never as the main writing system.\n- Pay close attention to tones, measure words, aspect particles, word order, and natural Mainland usage.\n- Avoid Traditional Chinese, Cantonese, Taiwan, Hong Kong, or Macau variants unless explicitly comparing them."
        }
        _ => "",
    }
}
