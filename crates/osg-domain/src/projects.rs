use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::ProjectId;

pub const MAX_PROJECT_NAME_CHARS: usize = 200;
pub const MAX_REVISION_REASON_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    id: ProjectId,
    name: String,
}

impl ProjectMetadata {
    pub fn new(name: impl Into<String>) -> Result<Self, ProjectError> {
        Self::with_id(ProjectId::new(), name)
    }

    pub fn with_id(id: ProjectId, name: impl Into<String>) -> Result<Self, ProjectError> {
        let name = name.into();
        let name = normalize_text(&name, "project name", MAX_PROJECT_NAME_CHARS)?;
        Ok(Self { id, name })
    }

    #[must_use]
    pub const fn id(&self) -> ProjectId {
        self.id
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl<'de> Deserialize<'de> for ProjectMetadata {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawProjectMetadata {
            id: ProjectId,
            name: String,
        }

        let raw = RawProjectMetadata::deserialize(deserializer)?;
        Self::with_id(raw.id, raw.name).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct RevisionReason(String);

impl RevisionReason {
    pub fn new(value: impl Into<String>) -> Result<Self, ProjectError> {
        let value = value.into();
        normalize_text(&value, "revision reason", MAX_REVISION_REASON_CHARS).map(Self)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_inner(self) -> String {
        self.0
    }
}

impl fmt::Display for RevisionReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl TryFrom<String> for RevisionReason {
    type Error = ProjectError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl<'de> Deserialize<'de> for RevisionReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

fn normalize_text(
    value: &str,
    field: &'static str,
    max_chars: usize,
) -> Result<String, ProjectError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ProjectError::Blank { field });
    }
    if value.chars().any(char::is_control) {
        return Err(ProjectError::ControlCharacter { field });
    }
    let actual_chars = value.chars().count();
    if actual_chars > max_chars {
        return Err(ProjectError::TooLong {
            field,
            max_chars,
            actual_chars,
        });
    }
    Ok(value.to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProjectError {
    #[error("{field} cannot be blank")]
    Blank { field: &'static str },
    #[error("{field} cannot contain control characters")]
    ControlCharacter { field: &'static str },
    #[error(
        "{field} is too long: {actual_chars} characters exceeds the {max_chars} character limit"
    )]
    TooLong {
        field: &'static str,
        max_chars: usize,
        actual_chars: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_PROJECT_NAME_CHARS, MAX_REVISION_REASON_CHARS, ProjectError, ProjectMetadata,
        RevisionReason,
    };

    #[test]
    fn project_names_are_trimmed_and_validated_by_character_count() {
        let project = ProjectMetadata::new("  My captions  ").expect("valid project");
        assert_eq!(project.name(), "My captions");

        for invalid in ["", "   ", "line\nbreak"] {
            assert!(ProjectMetadata::new(invalid).is_err());
        }

        assert!(ProjectMetadata::new("界".repeat(MAX_PROJECT_NAME_CHARS)).is_ok());
        assert!(matches!(
            ProjectMetadata::new("界".repeat(MAX_PROJECT_NAME_CHARS + 1)),
            Err(ProjectError::TooLong {
                field: "project name",
                ..
            })
        ));
    }

    #[test]
    fn project_deserialization_cannot_bypass_name_invariants() {
        let id = crate::ProjectId::new();
        let json = format!(r#"{{"id":"{id}","name":"  "}}"#);
        assert!(serde_json::from_str::<ProjectMetadata>(&json).is_err());
    }

    #[test]
    fn revision_reasons_are_nonempty_bounded_and_round_trip() {
        let reason =
            RevisionReason::new("  Imported legacy subtitles  ").expect("valid revision reason");
        assert_eq!(reason.as_str(), "Imported legacy subtitles");

        let json = serde_json::to_string(&reason).expect("serializable reason");
        let decoded: RevisionReason = serde_json::from_str(&json).expect("valid reason");
        assert_eq!(decoded, reason);
        assert!(RevisionReason::new(" ").is_err());
        assert!(RevisionReason::new("x".repeat(MAX_REVISION_REASON_CHARS + 1)).is_err());
    }
}
