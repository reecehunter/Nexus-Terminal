use crate::{
    chat::{available_tools, ReasoningEffort},
    settings::ModelOption,
    streaming::OpenAiClient,
};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub fn apply_reasoning(body: &mut Value, effort: ReasoningEffort) {
    // Non-reasoning models reject reasoning parameters, even effort "none".
    if effort != ReasoningEffort::Off {
        body["reasoning"] = json!({"effort": effort});
        body["include"] = json!(["reasoning.encrypted_content"]);
    }
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelOption>,
}

pub async fn list_models(key: &str) -> Result<Vec<ModelOption>> {
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()?
        .get("https://api.openai.com/v1/models")
        .bearer_auth(key)
        .send()
        .await
        .context("Could not connect to OpenAI. Check your internet connection.")?;
    crate::streaming::check_status(response.status())?;
    let mut models = response
        .json::<ModelsResponse>()
        .await
        .context("OpenAI returned an invalid model list")?
        .data;
    // Listing indicates account visibility, not Responses/tool compatibility; the probe below is authoritative.
    models.retain(|model| {
        model.id.starts_with("gpt-")
            || model.id.starts_with("o1")
            || model.id.starts_with("o3")
            || model.id.starts_with("o4")
    });
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    if models.is_empty() {
        bail!("No text models are available to this API key. Check project model permissions.");
    }
    Ok(models)
}

pub async fn validate(key: &str, model: &str, effort: ReasoningEffort) -> Result<ReasoningEffort> {
    validate_with_client(key, model, effort, OpenAiClient::new()?).await
}

async fn validate_with_client(
    key: &str,
    model: &str,
    effort: ReasoningEffort,
    client: OpenAiClient,
) -> Result<ReasoningEffort> {
    if model.is_empty() || model.len() > 120 || model.chars().any(char::is_whitespace) {
        bail!("Enter a valid model ID");
    }
    let mut body = json!({
        "model": model,
        "input": "Reply with only OK. This is a connection test; do not call any tools.",
        "store": false, "stream": true, "max_output_tokens": 4096,
        "parallel_tool_calls": false,
        // Validate the actual agent schemas without giving the probe access to any terminal or file.
        "tools": available_tools(true, true), "tool_choice": "none",
    });
    apply_reasoning(&mut body, effort);
    let cancel = CancellationToken::new();
    let mut accepted_effort = effort;
    let output = match client.response(key, body.clone(), &cancel, |_| {}).await {
        Ok(output) => output,
        Err(error)
            if effort != ReasoningEffort::Off
                && error
                    .downcast_ref::<crate::streaming::UnsupportedReasoning>()
                    .is_some() =>
        {
            // Retry only this explicit capability rejection, then persist the accepted configuration.
            body.as_object_mut().unwrap().remove("reasoning");
            body.as_object_mut().unwrap().remove("include");
            accepted_effort = ReasoningEffort::Off;
            client.response(key, body, &cancel, |_| {}).await?
        }
        Err(error) => return Err(error),
    };
    if !output.iter().any(|item| {
        item["type"] == "message"
            && item["content"].as_array().is_some_and(|content| {
                content.iter().any(|part| {
                    part["type"] == "output_text"
                        && part["text"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                })
            })
    }) {
        bail!("The selected model did not return a text response. Choose another model or reasoning setting.");
    }
    Ok(accepted_effort)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn off_omits_reasoning_while_none_is_sent_explicitly() {
        let mut body = json!({"model": "test"});
        apply_reasoning(&mut body, ReasoningEffort::Off);
        assert!(body.get("reasoning").is_none());
        assert!(body.get("include").is_none());
        apply_reasoning(&mut body, ReasoningEffort::None);
        assert_eq!(body["reasoning"]["effort"], "none");
    }

    #[test]
    fn model_list_accepts_provider_field_names() {
        let response: ModelsResponse =
            serde_json::from_value(json!({"data":[{"id":"gpt-fixture","owned_by":"provider"}]}))
                .unwrap();
        assert_eq!(response.data[0].owned_by, "provider");
        assert_eq!(
            serde_json::to_value(&response.data[0]).unwrap()["ownedBy"],
            "provider"
        );
    }

    #[tokio::test]
    async fn invalid_model_ids_fail_before_any_network_request() {
        for model in ["", " model", "model with spaces"] {
            let result = validate_with_client(
                "fixture",
                model,
                ReasoningEffort::Off,
                OpenAiClient::for_test("http://127.0.0.1:1".into()),
            )
            .await;
            assert!(result.unwrap_err().to_string().contains("valid model ID"));
        }
    }

    #[test]
    fn rejected_request_options_and_credentials_have_recovery_messages() {
        for (code, recovery) in [
            (400, "reasoning"),
            (401, "API key"),
            (403, "permissions"),
            (404, "models"),
            (429, "billing"),
        ] {
            let error =
                crate::streaming::check_status(reqwest::StatusCode::from_u16(code).unwrap())
                    .unwrap_err();
            assert!(error.to_string().contains(recovery));
        }
    }

    #[tokio::test]
    async fn probe_checks_agent_options_without_sending_user_context() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let body = loop {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length])
                            .unwrap();
                    }
                }
            };
            assert_eq!(body["tool_choice"], "none");
            assert_eq!(body["tools"].as_array().unwrap().len(), 6);
            assert_eq!(body["reasoning"]["effort"], "medium");
            assert_eq!(body["store"], false);
            assert!(!body["input"].as_str().unwrap().contains("sessionId"));
            let event = json!({"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}});
            let data = format!("data: {event}\n\n");
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{data}", data.len()).as_bytes()).await.unwrap();
        });
        tokio::time::timeout(
            Duration::from_secs(5),
            validate_with_client(
                "fixture",
                "fixture-model",
                ReasoningEffort::Medium,
                OpenAiClient::for_test(endpoint),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        server.await.unwrap();
    }
    #[tokio::test]
    async fn reasoning_fallback_retries_only_capability_errors_and_requires_success() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (code, parameter, retry_status, expected_effort) in [
            (
                "unsupported_parameter",
                "reasoning.effort",
                200,
                Some(ReasoningEffort::Off),
            ),
            ("unsupported_parameter", "reasoning", 401, None),
            ("unsupported_value", "reasoning.effort", 200, None),
            ("unsupported_parameter", "tools", 200, None),
        ] {
            let should_retry =
                code == "unsupported_parameter" && parameter.starts_with("reasoning");
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let mut requests = Vec::new();
                for attempt in 0..if should_retry { 2 } else { 1 } {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = Vec::new();
                    loop {
                        let mut buffer = [0; 4096];
                        let count = socket.read(&mut buffer).await.unwrap();
                        assert!(count > 0);
                        bytes.extend_from_slice(&buffer[..count]);
                        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..end]);
                            let length: usize = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_lowercase()
                                        .strip_prefix("content-length: ")
                                        .map(str::to_owned)
                                })
                                .unwrap()
                                .parse()
                                .unwrap();
                            if bytes.len() >= end + 4 + length {
                                requests.push(
                                    serde_json::from_slice::<Value>(
                                        &bytes[end + 4..end + 4 + length],
                                    )
                                    .unwrap(),
                                );
                                break;
                            }
                        }
                    }
                    let status = if attempt == 0 { 400 } else { retry_status };
                    let data = if status == 200 {
                        format!(
                            "data: {}\n\n",
                            json!({"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}})
                        )
                    } else {
                        json!({"error":{"code":code,"param":parameter}}).to_string()
                    };
                    socket.write_all(format!("HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len()).as_bytes()).await.unwrap();
                }
                requests
            });
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                validate_with_client(
                    "fixture",
                    "fixture-model",
                    ReasoningEffort::Medium,
                    OpenAiClient::for_test(endpoint),
                ),
            )
            .await
            .unwrap();
            match expected_effort {
                Some(effort) => assert_eq!(result.unwrap(), effort),
                None => assert!(result.is_err()),
            }
            let requests = server.await.unwrap();
            assert_eq!(requests[0]["reasoning"]["effort"], "medium");
            if should_retry {
                assert!(requests[1].get("reasoning").is_none());
                assert!(requests[1].get("include").is_none());
                assert_eq!(requests[1]["tools"], requests[0]["tools"]);
            }
        }
    }
}
