use std::{fmt, str::FromStr, sync::Mutex};

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

const UUID_V7_TIMESTAMP_MASK: u128 = (1_u128 << 48) - 1;
const UUID_V7_RAND_A_MASK: u128 = (1_u128 << 12) - 1;
const UUID_V7_RAND_B_MASK: u128 = (1_u128 << 62) - 1;
const UUID_V7_VERSION_BITS: u128 = 7_u128 << 76;
const UUID_RFC4122_VARIANT_BITS: u128 = 0b10_u128 << 62;

static LAST_ISSUED_UUID_V7: Mutex<Option<Uuid>> = Mutex::new(None);

fn process_monotonic_uuid_v7() -> Uuid {
    let mut last_issued = LAST_ISSUED_UUID_V7
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let candidate = Uuid::now_v7();
    let issued = ensure_uuid_v7_after(*last_issued, candidate);
    *last_issued = Some(issued);
    issued
}

fn ensure_uuid_v7_after(previous: Option<Uuid>, candidate: Uuid) -> Uuid {
    match previous {
        Some(previous) if candidate <= previous => next_uuid_v7(previous),
        _ => candidate,
    }
}

fn next_uuid_v7(previous: Uuid) -> Uuid {
    let value = previous.as_u128();
    let mut timestamp_ms = (value >> 80) & UUID_V7_TIMESTAMP_MASK;
    let mut rand_a = (value >> 64) & UUID_V7_RAND_A_MASK;
    let mut rand_b = value & UUID_V7_RAND_B_MASK;

    if rand_b < UUID_V7_RAND_B_MASK {
        rand_b += 1;
    } else if rand_a < UUID_V7_RAND_A_MASK {
        rand_a += 1;
        rand_b = 0;
    } else {
        timestamp_ms = timestamp_ms
            .checked_add(1)
            .filter(|timestamp_ms| *timestamp_ms <= UUID_V7_TIMESTAMP_MASK)
            .expect("process-monotonic UUIDv7 value space exhausted");
        rand_a = 0;
        rand_b = 0;
    }

    uuid_v7_from_parts(timestamp_ms, rand_a, rand_b)
}

const fn uuid_v7_from_parts(timestamp_ms: u128, rand_a: u128, rand_b: u128) -> Uuid {
    Uuid::from_u128(
        (timestamp_ms << 80)
            | UUID_V7_VERSION_BITS
            | (rand_a << 64)
            | UUID_RFC4122_VARIANT_BITS
            | rand_b,
    )
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
                Self(process_monotonic_uuid_v7())
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
    use std::{collections::HashSet, sync::Barrier, thread};

    use uuid::{Uuid, Variant, Version};

    use super::{
        AssetId, CueId, IdError, JobId, ProjectId, RevisionId, TrackId, UUID_V7_RAND_A_MASK,
        UUID_V7_RAND_B_MASK, UUID_V7_TIMESTAMP_MASK, ensure_uuid_v7_after, next_uuid_v7,
        uuid_v7_from_parts,
    };

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
        assert!(values.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn generated_ids_are_unique_and_creation_ordered() {
        let ids: Vec<ProjectId> = (0..10_000).map(|_| ProjectId::new()).collect();
        let unique: HashSet<ProjectId> = ids.iter().copied().collect();

        assert_eq!(unique.len(), ids.len());
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn descending_uuid_v7_candidate_advances_from_last_issued_value() {
        let previous = "018bcfe5-6800-7000-bfff-fff391672cca"
            .parse::<Uuid>()
            .expect("valid prior UUIDv7");
        let regressed = "018bcfe5-6800-7000-8000-0006cd31b7ee"
            .parse::<Uuid>()
            .expect("valid regressed UUIDv7");

        assert!(regressed < previous);

        let repaired = ensure_uuid_v7_after(Some(previous), regressed);

        assert_eq!(
            repaired,
            "018bcfe5-6800-7000-bfff-fff391672ccb"
                .parse::<Uuid>()
                .expect("valid repaired UUIDv7")
        );
        assert_eq!(repaired.get_version(), Some(Version::SortRand));
        assert_eq!(repaired.get_variant(), Variant::RFC4122);
        assert_eq!(repaired.get_timestamp(), previous.get_timestamp());
    }

    #[test]
    fn equal_candidates_advance_and_greater_candidates_pass_through() {
        let previous = "018bcfe5-6800-7000-bfff-fff391672cca"
            .parse::<Uuid>()
            .expect("valid prior UUIDv7");
        let greater = "018bcfe5-6801-7000-8000-000000000000"
            .parse::<Uuid>()
            .expect("valid greater UUIDv7");

        assert_eq!(
            ensure_uuid_v7_after(Some(previous), previous),
            next_uuid_v7(previous)
        );
        assert_eq!(ensure_uuid_v7_after(Some(previous), greater), greater);
        assert_eq!(ensure_uuid_v7_after(None, greater), greater);
    }

    #[test]
    fn uuid_v7_successor_carries_across_payload_fields() {
        const TIMESTAMP_MS: u128 = 1_700_000_000_000;

        let rand_b_max = uuid_v7_from_parts(TIMESTAMP_MS, 0x123, UUID_V7_RAND_B_MASK);
        assert_eq!(
            next_uuid_v7(rand_b_max),
            uuid_v7_from_parts(TIMESTAMP_MS, 0x124, 0)
        );

        let payload_max =
            uuid_v7_from_parts(TIMESTAMP_MS, UUID_V7_RAND_A_MASK, UUID_V7_RAND_B_MASK);
        let next_timestamp = next_uuid_v7(payload_max);
        assert_eq!(next_timestamp, uuid_v7_from_parts(TIMESTAMP_MS + 1, 0, 0));
        assert_eq!(next_timestamp.get_version(), Some(Version::SortRand));
        assert_eq!(next_timestamp.get_variant(), Variant::RFC4122);
    }

    #[test]
    #[should_panic(expected = "process-monotonic UUIDv7 value space exhausted")]
    fn total_uuid_v7_space_exhaustion_fails_loudly() {
        let final_uuid = uuid_v7_from_parts(
            UUID_V7_TIMESTAMP_MASK,
            UUID_V7_RAND_A_MASK,
            UUID_V7_RAND_B_MASK,
        );

        let _ = next_uuid_v7(final_uuid);
    }

    #[test]
    fn concurrent_ids_remain_locally_ordered_and_globally_unique() {
        const WORKER_COUNT: usize = 8;
        const IDS_PER_WORKER: usize = 2_048;

        let barrier = Barrier::new(WORKER_COUNT);
        let ids = thread::scope(|scope| {
            let mut workers = Vec::with_capacity(WORKER_COUNT);
            for _ in 0..WORKER_COUNT {
                let barrier = &barrier;
                workers.push(scope.spawn(move || {
                    barrier.wait();
                    let ids: Vec<ProjectId> =
                        (0..IDS_PER_WORKER).map(|_| ProjectId::new()).collect();
                    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
                    ids
                }));
            }

            workers
                .into_iter()
                .flat_map(|worker| worker.join().expect("ID worker completes"))
                .collect::<Vec<_>>()
        });
        let unique: HashSet<ProjectId> = ids.iter().copied().collect();

        assert_eq!(ids.len(), WORKER_COUNT * IDS_PER_WORKER);
        assert_eq!(unique.len(), ids.len());
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
