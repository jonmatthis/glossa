//! OpenAI-compatible AI client (OpenRouter / Groq) with streaming, JSON
//! schema-constrained structured output, and the failure-mode handling we
//! learned the hard way in FreeLingo: inline $defs for grammar-constrained
//! decoders, prompted-JSON fallback for providers that reject schemas, and
//! validation retries with error feedback.

use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use log::{debug, error, info, warn};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Session counters for RETRIES of transient, expected failures (429s,
/// malformed model output fed back for correction). These are NOT fallbacks:
/// nothing degrades silently. If one of these climbs, the model/prompt is
/// misbehaving and should be looked at — but the call still succeeded.
pub fn retry_stats_snapshot() -> [(&'static str, u64); 4] {
    [
        ("parse_retry", PARSE_RETRY.load(Ordering::Relaxed)),
        ("validation_retry", VALIDATION_RETRY.load(Ordering::Relaxed)),
        ("http_429_retry", HTTP_429_RETRY.load(Ordering::Relaxed)),
        ("retries_exhausted", RETRIES_EXHAUSTED.load(Ordering::Relaxed)),
    ]
}

pub static PARSE_RETRY: AtomicU64 = AtomicU64::new(0);
pub static VALIDATION_RETRY: AtomicU64 = AtomicU64::new(0);
pub static HTTP_429_RETRY: AtomicU64 = AtomicU64::new(0);
pub static RETRIES_EXHAUSTED: AtomicU64 = AtomicU64::new(0);

pub struct Provider {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// Dereference `$ref` so grammar-constrained decoders see it all.
/// schemars 0.8 emits `definitions` (draft-07 style); other generators emit
/// `$defs`. Accept both — unresolved refs 400 on several providers (Gemini).
/// This function MUST actually inline: an early version looked only for
/// `$defs` and was a silent no-op.
pub fn inline_defs(mut schema: Value) -> Value {
    let defs = schema
        .get("$defs")
        .or_else(|| schema.get("definitions"))
        .cloned()
        .unwrap_or(Value::Null);

    fn resolve(defs: &Value, reference: &str) -> Option<Value> {
        let name = reference
            .strip_prefix("#/$defs/")
            .or_else(|| reference.strip_prefix("#/definitions/"))?;
        defs.get(name).cloned()
    }

    fn walk(node: &mut Value, defs: &Value) {
        match node {
            Value::Object(map) => {
                if let Some(Value::String(reference)) = map.get("$ref") {
                    if let Some(def) = resolve(defs, reference) {
                        let mut def = def;
                        walk(&mut def, defs);
                        *node = def;
                        return;
                    }
                }
                map.remove("$defs");
                map.remove("definitions");
                for (_, value) in map.iter_mut() {
                    walk(value, defs);
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, defs);
                }
            }
            _ => {}
        }
    }

    walk(&mut schema, &defs);
    schema
}

/// Strip markdown fences and extract the outermost JSON object if the model
/// wrapped it in prose.
pub fn extract_json(raw: &str) -> String {
    // Fence-stripping is unreliable (models truncate mid-fence, wrap in
    // prose, add trailing junk) - grabbing the outermost {..} always works
    // for object-shaped payloads, which every structured call produces.
    let trimmed = raw.trim();
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if end > start {
            return trimmed[start..=end].to_string();
        }
    }
    trimmed.to_string()
}

/// Char-boundary-safe truncation for log lines. Slicing a &str at a raw byte
/// offset panics when the offset lands inside a multi-byte character (e.g.
/// '¡') — which degenerate model output WILL hit eventually.
pub fn truncate_for_log(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// "Do not think" — in each family's native dialect. Gemini/DeepSeek take
/// `enabled: false`; OpenAI reasoning models take `effort: minimal`
/// (`enabled` is not a field they accept and 400s under require_parameters).
fn reasoning_off(model: &str) -> Value {
    if model.starts_with("openai/") {
        json!({"effort": "minimal"})
    } else {
        json!({"enabled": false})
    }
}

/// OpenAI reasoning models (gpt-5 family) reject ANY explicit temperature —
/// the field must be absent for them. Other families accept it normally.
fn apply_dialect(model: &str, payload: &mut Value) {
    if model.starts_with("openai/") {
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("temperature");
        }
    }
}

impl Provider {
    pub fn openrouter(api_key: &str, model: &str) -> Self {
        Self {
            base_url: "https://openrouter.ai/api/v1".into(),
            api_key: api_key.trim().into(),
            model: model.into(),
        }
    }

    /// Reserved for a future Groq TTS/text path.
    #[allow(dead_code)]
    pub fn groq(api_key: &str) -> Self {
        Self {
            base_url: "https://api.groq.com/openai/v1".into(),
            api_key: api_key.trim().into(),
            model: "whisper-large-v3-turbo".into(),
        }
    }

    fn client(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .unwrap_or_default()
    }

    /// Consume an SSE chat stream, forwarding each text delta to `on_delta`
    /// and returning the complete concatenated reply.
    pub async fn chat_streaming(
        &self,
        messages: &[Value],
        temperature: f64,
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String, String> {
        // Reasoning models (GLM etc.) burn seconds "thinking" before the first
        // token — disable it for conversational replies. If a model rejects
        // the request, we FAIL LOUDLY: that model cannot serve this call and
        // must be changed, not papered over.
        let mut payload = json!({
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": true,
            "max_tokens": 600,
            "reasoning": reasoning_off(&self.model),
            // Route ONLY to providers that actually honor request parameters
            // (json_schema, reasoning, ...). Without this, OpenRouter
            // silently ignores unsupported params and hands the request to a
            // provider that prompts instead of constraining — which is how
            // "guaranteed" structured output degrades into suggestions.
            "provider": {"require_parameters": true},
        });
        apply_dialect(&self.model, &mut payload);
        let url = format!("{}/chat/completions", self.base_url);
        info!(
            "[ai] streaming request: model={} messages={} temp={:.2}",
            self.model,
            messages.len(),
            temperature
        );
        let response = self
            .client()
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                warn!("[ai] streaming request failed: {e}");
                format!("request failed: {e}")
            })?;
        let response = if response.status().as_u16() == 429 {
            // Rate limiting is a transient, expected failure: retry once.
            HTTP_429_RETRY.fetch_add(1, Ordering::Relaxed);
            warn!("[ai] 429 - backing off 3s and retrying once");
            tokio::time::sleep(Duration::from_secs(3)).await;
            self.client()
                .post(&url)
                .bearer_auth(&self.api_key)
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("request failed after 429 backoff: {e}"))?
        } else {
            response
        };
        let status = response.status();
        info!("[ai] streaming response: status={status}");
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            // FAIL LOUDLY. A rejected request means the model or the call is
            // wrong (e.g. model refuses reasoning:false). No fallback: fix
            // the cause — change the model or the request.
            error!("[ai] streaming request REJECTED: {status} {}", truncate_for_log(&body, 800));
            return Err(format!("API error {status}: {}", truncate_for_log(&body, 800)));
        }

        Self::consume_stream(response, on_delta).await
    }

    async fn consume_stream(
        response: reqwest::Response,
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String, String> {
        let started = std::time::Instant::now();
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buffer.find('\n') {
                let line: String = buffer.drain(..=pos).collect();
                let line = line.trim();
                if let Some(data) = line.strip_prefix("data: ") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        return Ok(full);
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        if let Some(delta) = value["choices"][0]["delta"]["content"].as_str() {
                            if !delta.is_empty() {
                                debug!("[ai] delta: {delta:?}");
                                full.push_str(delta);
                                on_delta(delta);
                            }
                        }
                    }
                }
            }
        }
        info!("[ai] stream complete: {} chars in {:.1}s", full.len(), started.elapsed().as_secs_f32());
        Ok(full)
    }

    async fn post_chat(&self, payload: &Value) -> Result<(String, String), String> {
        let started = std::time::Instant::now();
        let url = format!("{}/chat/completions", self.base_url);
        let mut response = self
            .client()
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(payload)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        // Upstream pools throw transient 429s when a burst of worker calls
        // lands together — back off once and retry.
        if response.status().as_u16() == 429 {
            HTTP_429_RETRY.fetch_add(1, Ordering::Relaxed);
            warn!("[ai] FALLBACK: 429 - backing off 3s and retrying once");
            tokio::time::sleep(Duration::from_secs(3)).await;
            response = self
                .client()
                .post(&url)
                .bearer_auth(&self.api_key)
                .json(payload)
                .send()
                .await
                .map_err(|e| format!("request failed after 429 backoff: {e}"))?;
        }
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("invalid response body: {e}"))?;
        info!(
            "[ai] response: status={} latency={:.1}s body_len={}",
            status,
            started.elapsed().as_secs_f32(),
            body.to_string().len()
        );
        if !status.is_success() {
            let detail = body["error"]
                .as_str()
                .or_else(|| body["error"]["message"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| body.to_string());
            warn!("[ai] API error: {}", truncate_for_log(&detail, 500));
            return Err(format!("API error {status}: {detail}"));
        }
        let content = body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if content.is_empty() {
            warn!(
                "[ai] EMPTY content; full message object: {}",
                body["choices"][0]["message"]
            );
            return Err("API returned an empty response".into());
        }
        Ok((content, body.to_string()))
    }

    /// Structured output. Design: the request is ALWAYS schema-constrained;
    /// a provider that rejects the schema is a model/call problem and fails
    /// LOUDLY (change the model, don't paper over it). The only retry is the
    /// corrective one for transient model-output defects (malformed JSON,
    /// failed validation) — the raw output plus the error go back to the
    /// model, same category as a 429 retry.
    pub async fn structured_validated<T, F>(
        &self,
        messages: &[Value],
        temperature: f64,
        name: &str,
        allow_reasoning: bool,
        validate: F,
    ) -> Result<T, String>
    where
        T: DeserializeOwned + JsonSchema,
        F: Fn(&T) -> Option<String>,
    {
        let root = serde_json::to_value(schemars::schema_for!(T))
            .map_err(|e| format!("schema generation failed: {e}"))?;
        let schema = inline_defs(root);

        let mut attempts: Vec<Value> = messages.to_vec();
        let mut last_error = String::new();

        for attempt in 0..3 {
            // Worker calls run with reasoning DISABLED (a thinking model
            // burns 30-60s before a mechanical task). The observer runs with
            // reasoning ENABLED and gets a larger budget for thinking +
            // output.
            // Schema-constrained decoding on EVERY attempt. With
            // require_parameters, a provider that can't honor the schema
            // fails at request time — loudly — instead of prompting.
            let mut payload = if allow_reasoning {
                json!({
                    "model": self.model,
                    "messages": attempts,
                    "temperature": temperature,
                    "max_tokens": 8000,
                                        "provider": {"require_parameters": true},
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {"name": name, "schema": schema}
                    },
                })
            } else {
                // 6000: stories emit the whole text as per-word glossed JSON —
                // a 200-word story is ~3000 output tokens; a tight cap forces
                // truncation.
                json!({
                    "model": self.model,
                    "messages": attempts,
                    "temperature": temperature,
                    "max_tokens": 6000,
                    "reasoning": reasoning_off(&self.model),
                    "provider": {"require_parameters": true},
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {"name": name, "schema": schema}
                    },
                })
            };
            apply_dialect(&self.model, &mut payload);
            info!(
                "[ai] structured attempt {attempt} ({name}): messages={}",
                attempts.len()
            );

            // Request-level failure (auth, schema rejection, bad model):
            // FAIL LOUDLY with the provider's actual error. No fallback.
            let (raw, _raw_body) = self.post_chat(&payload).await?;
            debug!("[ai] structured attempt {attempt} raw content: {}", truncate_for_log(&raw, 600));

            let cleaned = extract_json(&raw);
            match serde_json::from_str::<T>(&cleaned) {
                Ok(value) => {
                    if let Some(problem) = validate(&value) {
                        VALIDATION_RETRY.fetch_add(1, Ordering::Relaxed);
                        warn!("[ai] validation failed ({problem}) - corrective retry");
                        last_error = problem;
                        attempts.push(json!({"role": "assistant", "content": raw}));
                        attempts.push(json!({
                            "role": "user",
                            "content": format!(
                                "Validation error: {}. Return the COMPLETE \
                                 corrected JSON object, with every list populated.",
                                last_error
                            )
                        }));
                        continue;
                    }
                    info!("[ai] structured attempt {attempt} OK");
                    return Ok(value);
                }
                Err(e) => {
                    PARSE_RETRY.fetch_add(1, Ordering::Relaxed);
                    warn!("[ai] parse failed ({e}) - corrective retry");
                    warn!(
                        "[ai] raw response was: {}",
                        truncate_for_log(&raw, 600)
                    );
                    last_error = format!("invalid JSON: {e}");
                    attempts.push(json!({"role": "assistant", "content": raw}));
                    attempts.push(json!({
                        "role": "user",
                        "content": format!(
                            "That was not valid JSON ({e}). Respond with ONLY the \
                             JSON object matching the schema."
                        )
                    }));
                }
            }
        }
        RETRIES_EXHAUSTED.fetch_add(1, Ordering::Relaxed);
        error!(
            "[ai] structured output ({name}) failed after all attempts: {last_error}"
        );
        Err(format!("structured output failed after retries: {last_error}"))
    }
}

#[cfg(test)]
mod tests {
use super::*;
use serde_json::json;

// Regression: inline_defs looked only for `$defs`, but schemars 0.8 emits
// `definitions` — the function was a silent no-op and Gemini 400'd every
// schema with nested refs.
#[test]
fn inline_defs_resolves_definitions() {
    let schema = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": {
            "GuidedToken": { "type": "object", "properties": { "text": { "type": "string" } } }
        },
        "type": "object",
        "properties": {
            "tokens": { "type": "array", "items": { "$ref": "#/definitions/GuidedToken" } }
        }
    });
    let out = inline_defs(schema);
    let items = &out["properties"]["tokens"]["items"];
    assert!(items.get("$ref").is_none(), "ref must be inlined");
    assert_eq!(items["properties"]["text"]["type"], "string");
    assert!(out.get("definitions").is_none(), "definitions map stripped");
}

#[test]
fn inline_defs_handles_dollar_defs() {
    let schema = json!({
        "$defs": { "Item": { "type": "object" } },
        "properties": { "x": { "$ref": "#/$defs/Item" } }
    });
    let out = inline_defs(schema);
    assert!(out["properties"]["x"].get("$ref").is_none());
    assert_eq!(out["properties"]["x"]["type"], "object");
}

#[test]
fn inline_defs_resolves_transitive_refs() {
    let schema = json!({
        "definitions": {
            "A": { "$ref": "#/definitions/B" },
            "B": { "type": "string" }
        },
        "properties": { "x": { "$ref": "#/definitions/A" } }
    });
    let out = inline_defs(schema);
    assert_eq!(out["properties"]["x"]["type"], "string");
}

#[test]
fn inline_defs_keeps_unrelated_content() {
    let schema = json!({
        "definitions": { "B": { "type": "string" } },
        "type": "object",
        "properties": { "y": { "type": "number" } }
    });
    let out = inline_defs(schema);
    assert_eq!(out["properties"]["y"]["type"], "number");
}
}
