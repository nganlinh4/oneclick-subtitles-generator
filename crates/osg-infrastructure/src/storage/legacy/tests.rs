use rusqlite::Connection;

use super::ledger::{summary, validate_candidates, validate_outcome};
use super::*;
use crate::storage::ContentHash;

fn connection() -> Connection {
    let connection = Connection::open_in_memory().expect("open database");
    connection
        .execute_batch(include_str!("../sql/0001_initial.sql"))
        .expect("create schema");
    connection
}

fn candidate(key: &str, kind: LegacyImportItemKind) -> LegacyImportCandidate {
    LegacyImportCandidate::new(LegacyImportItemKey::new(key).expect("valid key"), kind)
}

#[test]
fn imports_resume_without_replaying_terminal_items() {
    let mut connection = connection();
    let candidates = vec![
        candidate("setting/theme", LegacyImportItemKind::Setting),
        candidate(
            "artifact/videos/example.mp4",
            LegacyImportItemKind::Artifact,
        ),
    ];
    let fingerprint = ContentHash::digest(b"same source");
    let first = prepare(
        &mut connection,
        LegacyImportSourceKind::ElectronRootV1,
        fingerprint,
        &candidates,
    )
    .expect("prepare import");
    record_item(
        &connection,
        first.source_id,
        &candidates[0],
        &LegacyImportItemOutcome::imported(None),
    )
    .expect("record setting");
    record_item(
        &connection,
        first.source_id,
        &candidates[1],
        &LegacyImportItemOutcome::failed("sourceChanged"),
    )
    .expect("record failure");
    assert_eq!(
        finish(&connection, first.source_id)
            .expect("finish partial import")
            .state,
        LegacyImportState::Failed
    );

    let resumed = prepare(
        &mut connection,
        LegacyImportSourceKind::ElectronRootV1,
        fingerprint,
        &candidates,
    )
    .expect("resume import");
    assert_eq!(resumed.source_id, first.source_id);
    assert_eq!(
        item_state(&connection, resumed.source_id, &candidates[0]).expect("read state"),
        Some(LegacyImportItemState::Imported)
    );
    assert_eq!(
        item_state(&connection, resumed.source_id, &candidates[1]).expect("read state"),
        Some(LegacyImportItemState::Failed)
    );
    record_item(
        &connection,
        resumed.source_id,
        &candidates[1],
        &LegacyImportItemOutcome::imported(Some(Uuid::now_v7())),
    )
    .expect("record retry");
    let complete = finish(&connection, resumed.source_id).expect("finish import");
    assert_eq!(complete.state, LegacyImportState::Complete);
    assert_eq!(complete.settings.imported, 1);
    assert_eq!(complete.artifacts.imported, 1);
}

#[test]
fn completed_fingerprint_is_idempotent() {
    let mut connection = connection();
    let candidate = candidate("ignored/oauth", LegacyImportItemKind::Ignored);
    let fingerprint = ContentHash::digest(b"finished source");
    let first = prepare(
        &mut connection,
        LegacyImportSourceKind::ElectronRootV1,
        fingerprint,
        std::slice::from_ref(&candidate),
    )
    .expect("prepare import");
    record_item(
        &connection,
        first.source_id,
        &candidate,
        &LegacyImportItemOutcome::skipped("unsupportedSecret"),
    )
    .expect("record skip");
    let finished = finish(&connection, first.source_id).expect("finish import");
    assert_eq!(finished.state, LegacyImportState::Complete);

    let repeated = prepare(
        &mut connection,
        LegacyImportSourceKind::ElectronRootV1,
        fingerprint,
        std::slice::from_ref(&candidate),
    )
    .expect("repeat import");
    assert_eq!(repeated, finished);
}

#[test]
fn a_running_fingerprint_cannot_be_prepared_concurrently() {
    let mut connection = connection();
    let candidate = candidate("setting/theme", LegacyImportItemKind::Setting);
    let fingerprint = ContentHash::digest(b"concurrent source");
    prepare(
        &mut connection,
        LegacyImportSourceKind::ElectronRootV1,
        fingerprint,
        std::slice::from_ref(&candidate),
    )
    .expect("prepare first import");

    assert!(matches!(
        prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            fingerprint,
            std::slice::from_ref(&candidate),
        ),
        Err(DatabaseError::LegacyImportBusy)
    ));
}

#[test]
fn a_fingerprint_cannot_resume_with_a_different_candidate_manifest() {
    let mut connection = connection();
    let first = candidate("setting/theme", LegacyImportItemKind::Setting);
    let fingerprint = ContentHash::digest(b"stable manifest");
    let prepared = prepare(
        &mut connection,
        LegacyImportSourceKind::ElectronRootV1,
        fingerprint,
        std::slice::from_ref(&first),
    )
    .expect("prepare import");
    record_item(
        &connection,
        prepared.source_id,
        &first,
        &LegacyImportItemOutcome::failed("interrupted"),
    )
    .expect("record interruption");
    finish(&connection, prepared.source_id).expect("finish failed import");

    let replacement = candidate("setting/locale", LegacyImportItemKind::Setting);
    assert!(matches!(
        prepare(
            &mut connection,
            LegacyImportSourceKind::ElectronRootV1,
            fingerprint,
            std::slice::from_ref(&replacement),
        ),
        Err(DatabaseError::InvalidLegacyImport)
    ));
}

#[test]
fn candidate_and_outcome_validation_is_strict() {
    assert!(LegacyImportItemKey::new("").is_err());
    assert!(LegacyImportItemKey::new("line\nbreak").is_err());
    let duplicate = candidate("same", LegacyImportItemKind::Setting);
    assert!(validate_candidates(&[duplicate.clone(), duplicate]).is_err());
    assert!(validate_outcome(&LegacyImportItemOutcome::failed("contains secret text")).is_err());
    assert!(
        validate_outcome(&LegacyImportItemOutcome {
            state: LegacyImportItemState::Skipped,
            target_id: Some(Uuid::now_v7()),
            detail_code: Some("skip"),
        })
        .is_err()
    );
}

#[test]
fn stale_running_sources_are_interrupted_on_startup() {
    let mut connection = connection();
    let candidate = candidate("setting/theme", LegacyImportItemKind::Setting);
    let prepared = prepare(
        &mut connection,
        LegacyImportSourceKind::ElectronRootV1,
        ContentHash::digest(b"crashed source"),
        std::slice::from_ref(&candidate),
    )
    .expect("prepare import");
    assert_eq!(interrupt_running(&connection).expect("interrupt"), 1);
    assert_eq!(
        summary(&connection, prepared.source_id)
            .expect("read summary")
            .state,
        LegacyImportState::Failed
    );
    assert!(matches!(
        record_item(
            &connection,
            prepared.source_id,
            &candidate,
            &LegacyImportItemOutcome::imported(None),
        ),
        Err(DatabaseError::InvalidLegacyImport)
    ));
}
