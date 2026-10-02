use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const MAX_EVENT_BYTES: usize = 512 * 1024;

#[derive(Debug)]
pub struct UnsupportedReasoning;

impl std::fmt::Display for UnsupportedReasoning {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("This model does not support reasoning options.")
    }
}
impl std::error::Error for UnsupportedReasoning {}

fn rejects_reasoning(error: &Value) -> bool {
    // An unsupported effort VALUE does not mean the entire parameter is unsupported.
    error["code"] == "unsupported_parameter"
        && matches!(
            error["param"].as_str(),
            Some("reasoning" | "reasoning.effort")
        )
}

pub fn check_status(status: reqwest::StatusCode) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    let hint = match status.as_u16() {
        400 => "This model rejected the selected request options. Try a different reasoning setting or model.",
        401 => "API key was rejected. Update it in Settings.",
        403 => "Your API key does not have access to this model. Check project permissions.",
        429 => "Rate limit or API quota reached. Check your API billing or try again later.",
        404 => "Model was not found. Reload available models in Settings.",
        _ => "OpenAI could not complete the request. Try again later.",
    };
    bail!("{hint} (HTTP {status})")
}

#[derive(Default)]
pub struct SseDecoder {
    pending: Vec<u8>,
    data: Vec<String>,
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > MAX_EVENT_BYTES {
            bail!("AI stream event exceeded its size limit");
        }
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|&byte| byte == b'\n') {
            let line = self.pending.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line)?.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = self.data.join("\n");
                    self.data.clear();
                    if data != "[DONE]" {
                        events
                            .push(serde_json::from_str(&data).context("Invalid AI stream event")?);
                    }
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
                if self.data.iter().map(String::len).sum::<usize>() > MAX_EVENT_BYTES {
                    bail!("AI stream event exceeded its size limit");
                }
            }
        }
        Ok(events)
    }
}

pub struct OpenAiClient {
    client: reqwest::Client,
    endpoint: String,
}
impl OpenAiClient {
    #[cfg(test)]
    pub fn for_test(endpoint: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            endpoint,
        }
    }
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(120))
                .build()?,
            endpoint: "https://api.openai.com/v1/responses".into(),
        })
    }

    pub async fn response(
        &self,
        key: &str,
        body: Value,
        cancel: &CancellationToken,
        mut on_text: impl FnMut(String),
    ) -> Result<Vec<Value>> {
        let response = tokio::select! {
            _ = cancel.cancelled() => bail!("Canceled"),
            response = self.client.post(&self.endpoint).bearer_auth(key).json(&body).send() => response.context("Could not connect to OpenAI")?,
        };
        let status = response.status();
        if status == reqwest::StatusCode::BAD_REQUEST {
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            // Bound error bodies and keep cancellation responsive; never expose provider payloads.
            while let Some(chunk) = tokio::select! {
                _ = cancel.cancelled() => bail!("Canceled"),
                chunk = stream.next() => chunk,
            } {
                let chunk = chunk.context("AI connection interrupted")?;
                if bytes.len() + chunk.len() > 64 * 1024 {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            if serde_json::from_slice::<Value>(&bytes)
                .is_ok_and(|body| rejects_reasoning(&body["error"]))
            {
                return Err(UnsupportedReasoning.into());
            }
            check_status(status)?;
            unreachable!("HTTP 400 always fails status validation");
        }
        check_status(status)?;
        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => bail!("Canceled"),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else {
                bail!("AI connection ended before the response completed. No pending command was executed.");
            };
            for event in decoder.push(&chunk.context("AI connection interrupted")?)? {
                match event["type"].as_str().unwrap_or_default() {
                    "response.output_text.delta" | "response.refusal.delta" => {
                        if let Some(delta) = event["delta"].as_str() {
                            on_text(delta.to_owned());
                        }
                    }
                    "response.completed" => {
                        return event["response"]["output"]
                            .as_array()
                            .cloned()
                            .context("AI response contained no output");
                    }
                    "response.failed" | "error" => bail!(
                        "OpenAI reported a response error. Try again or check the model settings."
                    ),
                    "response.incomplete" => {
                        bail!("AI response reached its output limit. Ask a smaller question.")
                    }
                    _ => {} // Tool argument fragments are deliberately never executed.
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_reasoning_parameter_rejections_allow_fallback() {
        assert!(rejects_reasoning(
            &serde_json::json!({"code":"unsupported_parameter", "param":"reasoning.effort"})
        ));
        for error in [
            serde_json::json!({"code":"unsupported_value", "param":"reasoning.effort"}),
            serde_json::json!({"code":"unsupported_parameter", "param":"tools"}),
            serde_json::json!({"message":"reasoning is unsupported"}),
            Value::Null,
        ] {
            assert!(!rejects_reasoning(&error));
        }
    }
    #[test]
    fn handles_fragmented_unicode_crlf_and_multiple_events() {
        let bytes = "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"λ🙂\"}\r\n\r\n: heartbeat\n\ndata: {\"type\":\"response.completed\"}\n\n".as_bytes();
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();
        for byte in bytes {
            events.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["delta"], "λ🙂");
    }
    #[test]
    fn rejects_bad_json_and_oversized_events() {
        assert!(SseDecoder::default().push(b"data: invalid\n\n").is_err());
        assert!(SseDecoder::default()
            .push(&vec![b'x'; MAX_EVENT_BYTES + 1])
            .is_err());
    }
    #[tokio::test]
    async fn invalid_credentials_return_an_actionable_error() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer).await;
            socket
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let client = OpenAiClient {
            client: reqwest::Client::new(),
            endpoint: format!("http://{address}"),
        };
        let error = client
            .response(
                "invalid-test-key",
                serde_json::json!({}),
                &CancellationToken::new(),
                |_| {},
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Update it in Settings"));
    }
}
