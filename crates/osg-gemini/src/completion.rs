use crate::{Error, GenerateResponse, Result};

/// Tracks provider termination independently of whether accumulated text parses.
/// A syntactically complete JSON prefix is not proof of a completed generation.
#[derive(Debug, Default)]
pub struct TextStreamCompletion {
    stopped: bool,
}

impl TextStreamCompletion {
    pub fn observe(&mut self, response: &GenerateResponse) -> Result<()> {
        if response
            .prompt_feedback
            .as_ref()
            .is_some_and(|feedback| feedback.block_reason.is_some())
        {
            return Err(Error::IncompleteTextOutput { reason: "blocked" });
        }
        let Some(candidate) = response.candidates.first() else {
            return Ok(());
        };
        if candidate
            .safety_ratings
            .iter()
            .any(|rating| rating.blocked == Some(true))
        {
            return Err(Error::IncompleteTextOutput { reason: "blocked" });
        }
        if self.stopped && response.text().is_some() {
            return Err(Error::IncompleteTextOutput {
                reason: "contentAfterStop",
            });
        }
        match candidate.finish_reason.as_deref() {
            None => Ok(()),
            Some("STOP") => {
                self.stopped = true;
                Ok(())
            }
            Some("MAX_TOKENS") => Err(Error::IncompleteTextOutput {
                reason: "outputLimit",
            }),
            Some(_) => Err(Error::IncompleteTextOutput {
                reason: "providerTermination",
            }),
        }
    }

    pub fn finish(self) -> Result<()> {
        if self.stopped {
            Ok(())
        } else {
            Err(Error::IncompleteTextOutput {
                reason: "missingStop",
            })
        }
    }
}

/// Tracks provider streaming completion for audio transcription.
/// Rejects truncated, early-EOF, or token-limited responses.
#[derive(Debug, Default)]
pub struct TranscriptionStreamCompletion {
    stopped: bool,
    total_words: usize,
}

impl TranscriptionStreamCompletion {
    pub fn observe(&mut self, response: &GenerateResponse) -> Result<()> {
        if let Some(feedback) = &response.prompt_feedback
            && feedback.block_reason.is_some()
        {
            return Err(Error::IncompleteTextOutput { reason: "blocked" });
        }
        let Some(candidate) = response.candidates.first() else {
            return Ok(());
        };
        if candidate.safety_ratings.iter().any(|r| r.blocked == Some(true)) {
            return Err(Error::IncompleteTextOutput { reason: "blocked" });
        }

        let words = response.transcription_words();
        if self.stopped && !words.is_empty() {
            return Err(Error::IncompleteTextOutput {
                reason: "contentAfterStop",
            });
        }
        self.total_words += words.len();

        match candidate.finish_reason.as_deref() {
            None => Ok(()),
            Some("STOP") => {
                self.stopped = true;
                Ok(())
            }
            Some("MAX_TOKENS") => Err(Error::IncompleteTextOutput {
                reason: "outputLimit",
            }),
            Some(_) => Err(Error::IncompleteTextOutput {
                reason: "providerTermination",
            }),
        }
    }

    pub fn finish(self) -> Result<usize> {
        if !self.stopped {
            return Err(Error::IncompleteTextOutput {
                reason: "missingStop",
            });
        }
        Ok(self.total_words)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(value: serde_json::Value) -> GenerateResponse {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn accepts_final_text_and_metadata_after_stop() {
        let mut completion = TextStreamCompletion::default();
        completion
            .observe(&response(
                json!({"candidates":[{"content":{"parts":[{"text":"[]"}]},"finishReason":"STOP"}]}),
            ))
            .unwrap();
        completion
            .observe(&response(json!({"usageMetadata":{"totalTokenCount":12}})))
            .unwrap();
        completion.finish().unwrap();
    }

    #[test]
    fn complete_json_without_provider_stop_is_not_success() {
        let mut completion = TextStreamCompletion::default();
        completion
            .observe(&response(
                json!({"candidates":[{"content":{"parts":[{"text":"[]"}]}}]}),
            ))
            .unwrap();
        assert!(completion.finish().is_err());
    }

    #[test]
    fn rejects_all_abnormal_terminations_even_with_valid_json() {
        for reason in [
            "MAX_TOKENS",
            "SAFETY",
            "RECITATION",
            "OTHER",
            "NEW_UNKNOWN_REASON",
        ] {
            let mut completion = TextStreamCompletion::default();
            assert!(completion.observe(&response(json!({"candidates":[{"content":{"parts":[{"text":"[]"}]},"finishReason":reason}]}))).is_err());
        }
    }

    #[test]
    fn rejects_blocked_prompt_and_content_after_stop() {
        let mut completion = TextStreamCompletion::default();
        assert!(
            completion
                .observe(&response(
                    json!({"promptFeedback":{"blockReason":"SAFETY"}})
                ))
                .is_err()
        );
        let mut completion = TextStreamCompletion::default();
        completion
            .observe(&response(json!({"candidates":[{"finishReason":"STOP"}]})))
            .unwrap();
        assert!(
            completion
                .observe(&response(
                    json!({"candidates":[{"content":{"parts":[{"text":"more"}]}}]})
                ))
                .is_err()
        );
    }

    #[test]
    fn transcription_stream_completion_happy_path_and_rejections() {
        let mut completion = TranscriptionStreamCompletion::default();
        completion
            .observe(&response(json!({
                "candidates": [{
                    "content": {
                        "parts": [{
                            "audioTranscription": {
                                "words": [
                                    {"word": "Hello", "startOffset": "0.1s", "endOffset": "0.5s"},
                                    {"word": "world", "startOffset": "0.6s", "endOffset": "1.0s"}
                                ]
                            }
                        }]
                    }
                }]
            })))
            .unwrap();

        completion
            .observe(&response(json!({
                "candidates": [{
                    "finishReason": "STOP"
                }]
            })))
            .unwrap();

        let total = completion.finish().unwrap();
        assert_eq!(total, 2);

        // Content after stop
        let mut completion = TranscriptionStreamCompletion::default();
        completion
            .observe(&response(json!({"candidates":[{"finishReason":"STOP"}]})))
            .unwrap();
        assert!(
            completion
                .observe(&response(json!({
                    "candidates": [{
                        "content": {
                            "parts": [{
                                "audioTranscription": {
                                    "words": [{"word": "extra", "startOffset": "1s", "endOffset": "2s"}]
                                }
                            }]
                        }
                    }]
                })))
                .is_err()
        );

        // Incomplete stream without STOP
        let completion = TranscriptionStreamCompletion::default();
        assert!(completion.finish().is_err());
    }
}
