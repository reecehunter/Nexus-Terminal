use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static PATTERNS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    vec![
        (
            "private key",
            Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
                .expect("private-key redaction pattern is valid"),
        ),
        (
            "credential",
            Regex::new(r#"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[^\s"';&]{8,}"#)
                .expect("credential redaction pattern is valid"),
        ),
        (
            "provider key",
            Regex::new(r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b")
                .expect("provider-key redaction pattern is valid"),
        ),
        (
            "bearer token",
            Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}").expect("bearer redaction pattern is valid"),
        ),
        (
            "email address",
            Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
                .expect("email redaction pattern is valid"),
        ),
        (
            "social security number",
            Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").expect("SSN redaction pattern is valid"),
        ),
        (
            "credit card number",
            Regex::new(r"\b(?:\d{4}[- ]?){3}\d{4}\b")
                .expect("card redaction pattern is valid"),
        ),
        (
            "phone number",
            Regex::new(r"(?x)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}")
                .expect("phone redaction pattern is valid"),
        ),
    ]
});

/// Redacts high-confidence secrets and common personal identifiers from provider-bound data.
pub struct Redactor {
    enabled: bool,
}

impl Redactor {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    pub fn redact_text(&self, text: &str) -> String {
        if !self.enabled {
            return text.to_owned();
        }
        PATTERNS
            .iter()
            .fold(text.to_owned(), |redacted, (kind, pattern)| {
                let replacement = format!("[REDACTED {kind}]");
                pattern
                    .replace_all(&redacted, replacement.as_str())
                    .into_owned()
            })
    }

    pub fn redact_value(&self, value: &mut Value) -> bool {
        match value {
            Value::String(text) => {
                let redacted = self.redact_text(text);
                let changed = redacted != *text;
                *text = redacted;
                changed
            }
            Value::Array(values) => {
                let mut changed = false;
                for value in values {
                    // Visit every element so nested values are redacted even after a prior change.
                    changed |= self.redact_value(value);
                }
                changed
            }
            Value::Object(values) => {
                let mut changed = false;
                for value in values.values_mut() {
                    // Visit every value so nested fields are redacted even after a prior change.
                    changed |= self.redact_value(value);
                }
                changed
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => false,
        }
    }

    pub fn contains_marker(&self, value: &Value) -> bool {
        if !self.enabled {
            return false;
        }
        match value {
            Value::String(text) => text.contains("[REDACTED "),
            Value::Array(values) => values.iter().any(|value| self.contains_marker(value)),
            Value::Object(values) => values.values().any(|value| self.contains_marker(value)),
            Value::Null | Value::Bool(_) | Value::Number(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Redactor;

    #[test]
    fn redacts_common_secrets_and_personal_identifiers() {
        let input = "Email jane@example.com, SSN 123-45-6789, card 4111 1111 1111 1111, key sk-1234567890abcdefghijklmnop, password=supersecretvalue";
        let redacted = Redactor::new(true).redact_text(input);

        assert!(!redacted.contains("jane@example.com"));
        assert!(!redacted.contains("123-45-6789"));
        assert!(!redacted.contains("4111 1111 1111 1111"));
        assert!(!redacted.contains("sk-1234567890abcdefghijklmnop"));
        assert!(!redacted.contains("supersecretvalue"));
    }

    #[test]
    fn preserves_text_when_disabled() {
        let input = "Contact jane@example.com with password=supersecretvalue";
        assert_eq!(Redactor::new(false).redact_text(input), input);
    }

    #[test]
    fn redacts_nested_json_strings() {
        let mut value = serde_json::json!({
            "screen": "token: abcdefghijklmnop",
            "items": ["jane@example.com"]
        });
        assert!(Redactor::new(true).redact_value(&mut value));
        assert_eq!(value["screen"], "[REDACTED credential]");
        assert_eq!(value["items"][0], "[REDACTED email address]");
        assert!(Redactor::new(true).contains_marker(&value));
    }
}
