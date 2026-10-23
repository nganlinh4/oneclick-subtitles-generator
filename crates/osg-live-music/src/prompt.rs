//! Validated, bounded steering prompts.

use std::fmt;

use serde::Serialize;

use crate::{Error, MAX_PROMPT_CHARS, MAX_PROMPTS, MAX_TOTAL_PROMPT_CHARS, Result};

/// A validated non-zero prompt used to steer a live music session.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeightedPrompt {
    text: String,
    weight: f32,
}

impl WeightedPrompt {
    /// Creates a bounded prompt. Lyria normalizes weights, while the `PromptDJ`
    /// UI exposes the inclusive range `(0, 2]` for active prompts.
    pub fn new(text: impl Into<String>, weight: f32) -> Result<Self> {
        let text = text.into();
        if text.trim().is_empty()
            || text.chars().count() > MAX_PROMPT_CHARS
            || !weight.is_finite()
            || weight <= 0.0
            || weight > 2.0
        {
            return Err(Error::InvalidPrompts);
        }
        Ok(Self { text, weight })
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub const fn weight(&self) -> f32 {
        self.weight
    }
}

impl fmt::Debug for WeightedPrompt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WeightedPrompt")
            .field("text", &"<redacted>")
            .field("weight", &self.weight)
            .finish()
    }
}

/// Validates the complete prompt set before it can cross the provider boundary.
pub fn validate_weighted_prompts(prompts: &[WeightedPrompt]) -> Result<()> {
    if prompts.is_empty() || prompts.len() > MAX_PROMPTS {
        return Err(Error::InvalidPrompts);
    }
    let mut total_chars = 0usize;
    for prompt in prompts {
        let prompt_chars = prompt.text.chars().count();
        total_chars = total_chars
            .checked_add(prompt_chars)
            .ok_or(Error::InvalidPrompts)?;
        if prompt.text.trim().is_empty()
            || prompt_chars > MAX_PROMPT_CHARS
            || !prompt.weight.is_finite()
            || prompt.weight <= 0.0
            || prompt.weight > 2.0
            || total_chars > MAX_TOTAL_PROMPT_CHARS
        {
            return Err(Error::InvalidPrompts);
        }
    }
    Ok(())
}
