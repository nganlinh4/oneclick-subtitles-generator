use std::fs;

use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactKind, ArtifactRegistration, CacheCategory, CacheKey, CacheWrite,
    ContentHash, Database,
};
use osg_media::{MediaTimeRange, WaveformLevel, WaveformPoint, WaveformPyramid};
use serde_json::json;
use tempfile::TempDir;

use super::{
    CACHE_ARTIFACT_KIND, CACHE_CATEGORY, MAX_CACHE_BYTES, WAVEFORM_ALGORITHM_VERSION,
    WaveformCacheSpec, decode, encode, lookup, maximum_pyramid_points, publish,
};

fn waveform() -> WaveformPyramid {
    WaveformPyramid {
        duration_us: 2_000_000,
        source_sample_rate_hz: 400,
        levels: vec![WaveformLevel {
            points_per_second: 100.0,
            points: vec![
                WaveformPoint {
                    minimum: -0.5,
                    maximum: 0.75,
                    root_mean_square: 0.25,
                },
                WaveformPoint {
                    minimum: -1.0,
                    maximum: 1.0,
                    root_mean_square: 0.5,
                },
            ],
        }],
    }
}

fn spec(source: u8) -> WaveformCacheSpec {
    WaveformCacheSpec::new(
        ContentHash::from_bytes([source; 32]),
        100,
        10_000,
        MediaTimeRange::new(0, None).expect("range"),
    )
}

fn database() -> (TempDir, Database) {
    let directory = TempDir::new().expect("temporary directory");
    let database = Database::open_with_artifact_root(
        directory.path().join("db/osg.sqlite3"),
        directory.path().join("artifacts"),
    )
    .expect("database");
    (directory, database)
}

#[test]
fn strict_round_trip_binds_every_cache_identity_input() {
    let request = spec(7);
    let bytes = encode(&waveform(), request).expect("encode");
    assert_eq!(decode(&bytes, request).expect("decode"), waveform());

    let different_source = spec(8);
    assert_ne!(
        request.key().expect("key"),
        different_source.key().expect("key")
    );
    assert!(decode(&bytes, different_source).is_err());
    let different_density = WaveformCacheSpec::new(
        ContentHash::from_bytes([7; 32]),
        101,
        10_000,
        MediaTimeRange::new(0, None).expect("range"),
    );
    assert_ne!(
        request.key().expect("key"),
        different_density.key().expect("key")
    );
    assert!(decode(&bytes, different_density).is_err());
    let different_limit = WaveformCacheSpec::new(
        ContentHash::from_bytes([7; 32]),
        100,
        11_000,
        MediaTimeRange::new(0, None).expect("range"),
    );
    assert_ne!(
        request.key().expect("key"),
        different_limit.key().expect("key")
    );
    let different_range = WaveformCacheSpec::new(
        ContentHash::from_bytes([7; 32]),
        100,
        10_000,
        MediaTimeRange::new(1_000, Some(2_000)).expect("range"),
    );
    assert_ne!(
        request.key().expect("key"),
        different_range.key().expect("key")
    );
}

#[test]
fn published_cache_hits_and_clear_removes_row_and_bytes() {
    let (_directory, database) = database();
    let request = spec(9);
    publish(&database, request, &waveform()).expect("publish");
    let hit = lookup(&database, request)
        .expect("lookup")
        .expect("cache hit");
    assert!(hit.cache_hit);
    assert_eq!(hit.waveform, waveform());
    let cached = database
        .lookup_cache(request.key().expect("key"))
        .expect("lookup artifact")
        .expect("artifact");
    let path = cached.path().to_owned();
    assert!(path.exists());
    assert_eq!(database.cache_info().expect("info").total_count, 1);

    let cleared = database
        .clear_cache_category(&CacheCategory::new(CACHE_CATEGORY).expect("category"))
        .expect("clear");
    assert_eq!(cleared.removed_count, 1);
    assert_eq!(database.cache_info().expect("info").total_count, 0);
    assert!(!path.exists());
}

#[test]
fn schema_corruption_is_evicted_and_becomes_a_miss() {
    let (_directory, database) = database();
    let request = spec(10);
    let mut bytes = encode(&waveform(), request).expect("encode");
    bytes[0] ^= 0xff;
    let draft = ArtifactDraft::new_cache(
        ArtifactKind::new(CACHE_ARTIFACT_KIND).expect("kind"),
        ContentHash::digest(&bytes),
        bytes.len() as u64,
        json!({"fixture": "schema-corruption"}),
    )
    .expect("draft");
    let staging = match database.register_artifact(&draft).expect("register") {
        ArtifactRegistration::Staging(staging) => staging,
        other => panic!("expected staging artifact, got {other:?}"),
    };
    fs::write(staging.path(), &bytes).expect("write");
    let write = CacheWrite::new(
        request.key().expect("key"),
        staging.record().id(),
        CacheCategory::new(CACHE_CATEGORY).expect("category"),
        WAVEFORM_ALGORITHM_VERSION,
        None,
    )
    .expect("write");
    database.commit_cache_artifact(&write).expect("commit");

    assert!(lookup(&database, request).expect("lookup").is_none());
    assert_eq!(database.cache_info().expect("info").total_count, 0);
    assert!(
        database
            .lookup_cache(request.key().expect("key"))
            .expect("lookup")
            .is_none()
    );
}

#[test]
fn truncated_unknown_and_non_finite_payloads_are_rejected() {
    let request = spec(11);
    let bytes = encode(&waveform(), request).expect("encode");
    assert!(decode(&bytes[..bytes.len() - 1], request).is_err());
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(decode(&trailing, request).is_err());
    let mut invalid = waveform();
    invalid.levels[0].points[0].minimum = f32::NAN;
    assert!(encode(&invalid, request).is_err());

    let category = CacheCategory::new(CACHE_CATEGORY).expect("category");
    let manual = CacheKey::derive(&category, WAVEFORM_ALGORITHM_VERSION, &[b"different"])
        .expect("manual key");
    assert_ne!(manual, request.key().expect("request key"));
}

#[test]
fn maximum_valid_request_has_headroom_inside_the_binary_cap() {
    let points = maximum_pyramid_points(1_000_000).expect("bounded pyramid");
    let maximum_level_count = 16_usize;
    let fixed_header = 8 + 4 + 4 + 32 + 4 + 8 + 8 + 1 + 8 + 8 + 4 + 4;
    let upper_bound = fixed_header + maximum_level_count * (8 + 4) + points * 12;
    assert_eq!(points, 1_333_009);
    assert!(upper_bound < MAX_CACHE_BYTES);
}
