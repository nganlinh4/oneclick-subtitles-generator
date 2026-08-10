use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;
use uuid::{Uuid, Variant, Version};

/// An invalid strongly typed domain identifier.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IdError {
    #[error("`{value}` is not a valid {entity} UUID: {reason}")]
    Malformed {
        entity: &'static str,
        value: String,
        reason: String,
    },
    #[error("{entity} IDs must be RFC 9562 UUIDv7 values (received `{value}`)")]
    NotVersionSeven { entity: &'static str, value: Uuid },
}

macro_rules! domain_id {
    ($name:ident, $entity:literal) => {
        #[doc = concat!("A time-sortable UUIDv7 identifier for a ", $entity, ".")]
        #[repr(transparent)]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            /// Creates an identifier using the process-monotonic `UUIDv7` generator.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            /// Validates and wraps an existing `UUIDv7` value.
            pub fn from_uuid(value: Uuid) -> Result<Self, IdError> {
                if value.get_version() == Some(Version::SortRand)
                    && value.get_variant() == Variant::RFC4122
                {
                    Ok(Self(value))
                } else {
                    Err(IdError::NotVersionSeven {
                        entity: $entity,
                        value,
                    })
                }
            }

            #[must_use]
            pub const fn as_uuid(&self) -> &Uuid {
                &self.0
            }

            #[must_use]
            pub const fn into_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl TryFrom<Uuid> for $name {
            type Error = IdError;

            fn try_from(value: Uuid) -> Result<Self, Self::Error> {
                Self::from_uuid(value)
            }
        }

        impl From<$name> for Uuid {
            fn from(value: $name) -> Self {
                value.into_uuid()
            }
        }

        impl AsRef<Uuid> for $name {
            fn as_ref(&self) -> &Uuid {
                self.as_uuid()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = IdError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                let uuid = Uuid::parse_str(value).map_err(|error| IdError::Malformed {
                    entity: $entity,
                    value: value.to_owned(),
                    reason: error.to_string(),
                })?;
                Self::from_uuid(uuid)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = Uuid::deserialize(deserializer)?;
                Self::from_uuid(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

domain_id!(ProjectId, "project");
domain_id!(AssetId, "asset");
domain_id!(TrackId, "track");
domain_id!(CueId, "cue");
domain_id!(RevisionId, "revision");
domain_id!(JobId, "job");

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use uuid::{Uuid, Variant, Version};

    use super::{AssetId, CueId, IdError, JobId, ProjectId, RevisionId, TrackId};

    #[test]
    fn every_identifier_uses_uuid_v7() {
        let values = [
            ProjectId::new().into_uuid(),
            AssetId::new().into_uuid(),
            TrackId::new().into_uuid(),
            CueId::new().into_uuid(),
            RevisionId::new().into_uuid(),
            JobId::new().into_uuid(),
        ];

        for value in values {
            assert_eq!(value.get_version(), Some(Version::SortRand));
            assert_eq!(value.get_variant(), Variant::RFC4122);
        }
    }

    #[test]
    fn generated_ids_are_unique_and_creation_ordered() {
        let ids: Vec<ProjectId> = (0..10_000).map(|_| ProjectId::new()).collect();
        let unique: HashSet<ProjectId> = ids.iter().copied().collect();

        assert_eq!(unique.len(), ids.len());
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn string_and_json_round_trips_preserve_the_type() {
        let id = JobId::new();
        let parsed: JobId = id.to_string().parse().expect("valid typed ID");
        let json = serde_json::to_string(&id).expect("serializable ID");
        let decoded: JobId = serde_json::from_str(&json).expect("deserializable ID");

        assert_eq!(parsed, id);
        assert_eq!(decoded, id);
    }

    #[test]
    fn existing_uuid_versions_cannot_cross_the_new_boundary() {
        let legacy_id = Uuid::new_v4();

        assert!(matches!(
            AssetId::from_uuid(legacy_id),
            Err(IdError::NotVersionSeven { entity: "asset", value }) if value == legacy_id
        ));

        let encoded = serde_json::to_string(&legacy_id).expect("serializable UUID");
        assert!(serde_json::from_str::<AssetId>(&encoded).is_err());
    }

    #[test]
    fn malformed_strings_report_the_target_entity() {
        assert!(matches!(
            "not-a-uuid".parse::<CueId>(),
            Err(IdError::Malformed { entity: "cue", .. })
        ));
    }
}
