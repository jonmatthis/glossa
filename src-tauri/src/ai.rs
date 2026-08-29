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
use std::time::Duration;

pub struct Provider {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// Dereference `$defs`/`$ref` so grammar-constrained decoders see it all.
/// Ollama AND several API gateways mishandle nested object references, which
/// lets the model omit nested keys. Pydantic/schemars emit $defs for every
/// nested model, so schemas are fully inlined before reaching the provider.
pub fn inline_defs(mut schema: Value) -> Value {
    let defs = schema.get("$defs").cloned().unwrap_or(Value::Null);

    fn walk(node: &mut Value, defs: &Value) {
        match node {
            Value::Object(map) => {
                if let Some(Value::String(reference)) = map.get("$ref") {
                    if let Some(name) = reference.strip_prefix("#/$defs/") {
                        if let Some(def) = defs.get(name) {
                            let mut cloned = def.clone();
                            walk(&mut cloned, defs);
                            *node = cloned;
                            return;
                        }
                    }
                }
                map.remove("$defs");
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

impl Provider {
    pub fn openrouter(api_key: &str, model: &str) -> Self {        Self {
            base_url: "https://openrouter.ai/api/v1".into(),
            api_key: api_key.into(),
            model: model.into(),
        }
    }

    /// Reserved for a future Groq TTS/text path.
    #[allow(dead_code)]
    pub fn groq(api_key: &str) -> Self {
        Self {
            base_url: "https://api.groq.com/openai/v1".into(),
            api_key: api_key.into(),
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
        // token — disable it for conversational replies, with a fallback if a
        // provider rejects the parameter.
        let payload = json!({
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": true,
            "max_tokens": 600,
            "reasoning": {"enabled": false},
        });
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
            warn!("[ai] streaming 429 - backing off 3s and retrying once");
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
            warn!("[ai] streaming error body: {}", &body[..body.len().min(500)]);
            // Some models mandate reasoning and reject the parameter — retry
            // once without it (mandatory-reasoning models then think anyway).
            warn!("[ai] retrying stream without reasoning parameter");
            let retry_payload = json!({
                "model": self.model,
                "messages": messages,
                "temperature": temperature,
                "stream": true,
                "max_tokens": 1200,
            });
            let retry = self
                .client()
                .post(&url)
                .bearer_auth(&self.api_key)
                .json(&retry_payload)
                .send()
                .await
                .map_err(|e| format!("request failed: {e}"))?;
            let rstatus = retry.status();
            if !rstatus.is_success() {
                let rbody = retry.text().await.unwrap_or_default();
                return Err(format!("API error {rstatus}: {rbody}"));
            }
            info!("[ai] retry (no reasoning param) accepted: status={rstatus}");
            return Self::consume_stream(retry, on_delta).await;
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
            warn!("[ai] 429 rate limited - backing off 3s and retrying once");
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
            warn!("[ai] API error: {}", &detail[..detail.len().min(500)]);
            return Err(format!("API error {status}: {detail}"));
        }
        let content = body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if content.is_empty() {
            warn!(
                "[ai] EMPTY content; full message object: {}",
                body["choices"][0]["message"].to_string()
            );
            return Err("API returned an empty response".into());
        }
        Ok((content, body.to_string()))
    }

    /// Structured output with the full FreeLingo fallback ladder:
    /// 1. native `json_schema` response format (constrained decoding where
    ///    supported), 2. prompted-JSON fallback for providers that reject the
    ///    schema, 3. one corrective retry with the deserialization error.
    /// `validate` enforces content-level rules (non-empty lists etc.) whose
    /// error message feeds the corrective retry.
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
            // Worker calls run with reasoning DISABLED (a thinking model burns
            // 30-60s before a mechanical task and can exhaust its token budget
            // before emitting content). The observer runs with reasoning
            // ENABLED — the parameter is simply absent so mandatory-reasoning
            // models accept the request — and gets a larger token budget to
            // cover thinking + output.
            let mut payload = if allow_reasoning {
                json!({
                    "model": self.model,
                    "messages": attempts,
                    "temperature": temperature,
                    "max_tokens": 8000,
                })
            } else {
                let mut p = json!({
                    "model": self.model,
                    "messages": attempts,
                    "temperature": temperature,
                    "max_tokens": 3000,
                });
                if attempt <= 1 {
                    p["reasoning"] = json!({"enabled": false});
                }
                p
            };
            if attempt == 0 {
                payload["response_format"] = json!({
                    "type": "json_schema",
                    "json_schema": {"name": name, "schema": schema}
                });
            }
            info!(
                "[ai] structured attempt {attempt} ({name}): schema={}, messages={}",
                attempt == 0,
                attempts.len()
            );

            let (raw, _raw_body) = match self.post_chat(&payload).await {
                Ok((raw, raw_body)) => (raw, raw_body),
                Err(e) => {
                    // Provider rejected the schema constraint — fall back to
                    // prompted JSON for subsequent attempts.
                    warn!("[ai] structured attempt {attempt} request failed: {e}");
                    if attempt == 0 {
                        last_error = e;
                        continue;
                    }
                    return Err(last_error);
                }
            };
            debug!("[ai] structured attempt {attempt} raw content: {}", &raw[..raw.len().min(600)]);

            let cleaned = extract_json(&raw);
            match serde_json::from_str::<T>(&cleaned) {
                Ok(value) => {
                    if let Some(problem) = validate(&value) {
                        warn!("[ai] structured attempt {attempt} validation failed: {problem}");
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
                    warn!("[ai] structured attempt {attempt} parse failed: {e}");
                    warn!(
                        "[ai] raw response was: {}",
                        &raw[..raw.len().min(600)]
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
        error!("[ai] structured output ({name}) failed after retries: {last_error}");
        Err(format!("structured output failed after retries: {last_error}"))
    }
}
