use crate::{Result, SpeechError};
use std::fmt;
use zeroize::Zeroize;

/// Provider credential held only by native code. It is never serialized,
/// displayed, or placed in process arguments.
pub struct SecretValue(String);

impl SecretValue {
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.is_empty() || value.len() > 64 * 1024 || value.chars().any(char::is_control) {
            return Err(SpeechError::InvalidInput("invalid provider secret"));
        }
        Ok(Self(value))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl Clone for SecretValue {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SecretValue")
            .field(&"<redacted>")
            .finish()
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_exposes_secret() {
        let secret = SecretValue::new("sk-sensitive-value").unwrap();
        let debug = format!("{secret:?}");
        assert!(!debug.contains("sensitive"));
        assert!(debug.contains("<redacted>"));
    }
}
