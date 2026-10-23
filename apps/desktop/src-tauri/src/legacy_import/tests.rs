use std::collections::BTreeMap;
use std::fs;
use std::fs::File;
use std::path::Path;

use osg_infrastructure::secrets::CredentialSetRequest;
use osg_infrastructure::secrets::{
    CredentialId, CredentialPurpose, CredentialService, CredentialState, SessionCredentialBackend,
};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactKind, ArtifactRegistration, ArtifactState,
    ContentHash, Database, DatabaseError, LegacyImportItemKind, LegacyImportState,
};
use serde_json::{Value, json};
use tempfile::TempDir;

use super::classification::{
    artifact_kind, is_project_scoped_setting_key, is_transient_setting_key,
};
use super::execution::{digest_exact, execute_import, publish_artifact};
use super::planning::{plan_legacy_root, plan_storage_items};
use super::source_files::{open_source_file, verify_source_path};
use super::types::{ImportWork, PlannedArtifact, PlanningError, SourceRoot};
use super::*;

const ALIAS_SECRET_VALUES: [(&str, &str); 9] = [
    ("clientSecret", "legacy-client-secret-never-in-sqlite"),
    ("client.secret", "legacy-dotted-secret-never-in-sqlite"),
    ("client:secret", "legacy-colon-secret-never-in-sqlite"),
    ("accessToken", "legacy-access-token-never-in-sqlite"),
    ("refreshToken", "legacy-refresh-token-never-in-sqlite"),
    ("privateKey", "legacy-private-key-never-in-sqlite"),
    ("apiKey", "legacy-api-key-never-in-sqlite"),
    ("APIKey", "legacy-acronym-api-key-never-in-sqlite"),
    ("oauthToken", "legacy-oauth-token-never-in-sqlite"),
];

fn write_source(root: &Path, secret: &str) {
    fs::create_dir_all(root.join("videos")).expect("create legacy videos");
    fs::write(root.join("videos/source.mp4"), b"legacy-video-bytes").expect("write legacy media");
    let mut settings = BTreeMap::from([
        ("theme".to_owned(), json!("dark")),
        ("gemini_api_key".to_owned(), json!(secret)),
        ("gemini_max_tokens".to_owned(), json!("8192")),
        ("maxTokens".to_owned(), json!("4096")),
        ("tokenCount".to_owned(), json!("1024")),
        (
            "current_file_url".to_owned(),
            json!("http://127.0.0.1/private-capability"),
        ),
        (
            "original_subtitles_map".to_owned(),
            json!(r#"{"1":{"start":0,"end":1,"text":"project-private"}}"#),
        ),
        (
            "youtube_url_history".to_owned(),
            json!(
                "[{\"id\":\"AbCdEfGhI_1\",\"url\":\"https://www.youtube.com/watch?v=AbCdEfGhI_1\",\"thumbnail\":\"https://img.youtube.com/vi/AbCdEfGhI_1/0.jpg\"}]"
            ),
        ),
        (
            "youtube_oauth_token".to_owned(),
            json!("unsupported-secret-token"),
        ),
    ]);
    for (key, value) in ALIAS_SECRET_VALUES {
        settings.insert(key.to_owned(), json!(value));
    }
    fs::write(
        root.join("localStorage.json"),
        serde_json::to_vec(&settings).expect("serialize settings"),
    )
    .expect("write legacy settings");
}

fn assert_alias_secret_settings_rejected(database: &Database) {
    for (key, _) in ALIAS_SECRET_VALUES {
        assert!(matches!(
            database.get_setting(APP_SETTINGS_SCOPE, key),
            Err(DatabaseError::SecretSetting)
        ));
    }
}

fn assert_project_settings_rejected(database: &Database) {
    for key in ["current_file_url", "original_subtitles_map"] {
        assert!(
            database
                .get_setting(APP_SETTINGS_SCOPE, key)
                .expect("read project/transient setting")
                .is_none()
        );
    }
}

#[test]
fn migration_is_idempotent_path_free_and_keeps_secrets_out_of_sqlite() {
    let temporary = TempDir::new().expect("temporary directory");
    let source = temporary.path().join("legacy");
    fs::create_dir_all(&source).expect("create source");
    let secret = "gemini-secret-never-in-sqlite-1234";
    write_source(&source, secret);

    let native = temporary.path().join("native");
    let database = Database::open(native.join("db/osg.sqlite3")).expect("open database");
    let credentials = CredentialService::new(database.clone(), SessionCredentialBackend::new());
    let first = execute_import(
        &database,
        &credentials,
        plan_legacy_root(&source).expect("plan import"),
    )
    .expect("execute import");
    assert_eq!(first.summary.state, LegacyImportState::Complete);
    assert_eq!(first.summary.artifacts.imported, 1);
    assert!(!first.already_imported);
    assert!(first.source_retained);
    let serialized_report = serde_json::to_string(&first).expect("serialize safe report");
    assert!(!serialized_report.contains(secret));
    assert!(!serialized_report.contains(source.to_string_lossy().as_ref()));
    assert_eq!(
        database
            .get_setting(APP_SETTINGS_SCOPE, "theme")
            .expect("read setting"),
        Some(Value::String("dark".to_owned()))
    );
    for (key, expected) in [
        ("gemini_max_tokens", json!("8192")),
        ("maxTokens", json!("4096")),
        ("tokenCount", json!("1024")),
    ] {
        assert_eq!(
            database
                .get_setting(APP_SETTINGS_SCOPE, key)
                .expect("read token-count setting"),
            Some(expected)
        );
    }
    assert_alias_secret_settings_rejected(&database);
    assert_project_settings_rejected(&database);
    assert!(
        database
            .get_setting(APP_SETTINGS_SCOPE, "youtube_url_history")
            .expect("read URL-bearing history")
            .is_none()
    );
    let credential_status = credentials
        .status(Some(CredentialPurpose::GeminiApiKey))
        .expect("credential status");
    assert_eq!(credential_status.credentials.len(), 1);

    let second = execute_import(
        &database,
        &credentials,
        plan_legacy_root(&source).expect("replan import"),
    )
    .expect("repeat import");
    assert!(second.already_imported);
    assert_eq!(
        credentials
            .status(Some(CredentialPurpose::GeminiApiKey))
            .expect("credential status")
            .credentials
            .len(),
        1
    );

    let backup = temporary.path().join("backup.sqlite3");
    database.backup_to(&backup).expect("backup database");
    let backup_bytes = fs::read(&backup).expect("read backup");
    assert!(
        !backup_bytes
            .windows(secret.len())
            .any(|window| window == secret.as_bytes())
    );
    for (_, value) in ALIAS_SECRET_VALUES {
        assert!(
            !backup_bytes
                .windows(value.len())
                .any(|window| window == value.as_bytes())
        );
    }
    assert!(source.join("localStorage.json").exists());
    let source_text = source.to_string_lossy();
    assert!(
        !backup_bytes
            .windows(source_text.len())
            .any(|window| window == source_text.as_bytes())
    );
    assert!(
        !backup_bytes
            .windows(b"videos/source.mp4".len())
            .any(|window| window == b"videos/source.mp4")
    );
}

#[test]
fn all_distinct_gemini_keys_import_and_exact_existing_secrets_are_not_duplicated() {
    let temporary = TempDir::new().expect("temporary directory");
    let source = temporary.path().join("legacy");
    fs::create_dir_all(&source).expect("create source");
    let existing = "existing-gemini-secret-1111";
    let second = "second-gemini-secret-2222";
    let third = "third-gemini-secret-3333";
    fs::write(
        source.join("localStorage.json"),
        serde_json::to_vec(&json!({
            "gemini_api_key": existing,
            "gemini_api_keys": serde_json::to_string(&[existing, second, third])
                .expect("serialize legacy key list")
        }))
        .expect("serialize settings"),
    )
    .expect("write settings");

    let database =
        Database::open(temporary.path().join("native/db/osg.sqlite3")).expect("open database");
    let credentials = CredentialService::new(database.clone(), SessionCredentialBackend::new());
    credentials
        .set(CredentialSetRequest::new(
            CredentialPurpose::GeminiApiKey,
            existing.to_owned(),
        ))
        .expect("preconfigure exact existing key");

    let report = execute_import(
        &database,
        &credentials,
        plan_legacy_root(&source).expect("plan import"),
    )
    .expect("execute import");

    assert_eq!(report.summary.state, LegacyImportState::Complete);
    assert_eq!(report.summary.credentials.imported, 2);
    assert_eq!(report.summary.credentials.skipped, 1);
    assert_eq!(
        credentials
            .status(Some(CredentialPurpose::GeminiApiKey))
            .expect("credential status")
            .credentials
            .len(),
        3
    );
}

#[test]
fn unavailable_singleton_metadata_is_reconciled_before_import_retry() {
    let temporary = TempDir::new().expect("temporary directory");
    let source = temporary.path().join("legacy");
    fs::create_dir_all(&source).expect("create source");
    fs::write(
        source.join("localStorage.json"),
        serde_json::to_vec(&json!({
            "youtube_api_key": "youtube-secret-1234"
        }))
        .expect("serialize settings"),
    )
    .expect("write settings");

    let database =
        Database::open(temporary.path().join("native/db/osg.sqlite3")).expect("open database");
    database
        .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeApiKey)
        .expect("simulate interrupted credential write");
    let credentials = CredentialService::new(database.clone(), SessionCredentialBackend::new());

    let report = execute_import(
        &database,
        &credentials,
        plan_legacy_root(&source).expect("plan import"),
    )
    .expect("execute import");

    assert_eq!(report.summary.state, LegacyImportState::Complete);
    assert_eq!(report.summary.credentials.imported, 1);
    let statuses = credentials
        .status(Some(CredentialPurpose::YouTubeApiKey))
        .expect("credential status")
        .credentials;
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].state, CredentialState::Ready);
}

#[test]
fn a_source_changed_after_planning_fails_without_accepting_wrong_bytes() {
    let temporary = TempDir::new().expect("temporary directory");
    let source = temporary.path().join("legacy");
    fs::create_dir_all(&source).expect("create source");
    write_source(&source, "gemini-key-1234");
    let plan = plan_legacy_root(&source).expect("plan import");
    fs::write(source.join("videos/source.mp4"), b"changed-video-byte")
        .expect("replace source with equal-sized content");

    let database =
        Database::open(temporary.path().join("native/db/osg.sqlite3")).expect("open database");
    let credentials = CredentialService::new(database.clone(), SessionCredentialBackend::new());
    let report = execute_import(&database, &credentials, plan).expect("execute import");

    assert_eq!(report.summary.state, LegacyImportState::Failed);
    assert_eq!(report.summary.artifacts.failed, 1);

    let artifact_root = temporary.path().join("native/artifacts");
    assert!(
        fs::read_dir(&artifact_root)
            .expect("read artifact root")
            .all(|entry| !entry
                .expect("artifact entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".pending-"))
    );

    fs::write(source.join("videos/source.mp4"), b"legacy-video-bytes")
        .expect("restore original source");
    let resumed = execute_import(
        &database,
        &credentials,
        plan_legacy_root(&source).expect("replan restored source"),
    )
    .expect("resume failed import");
    assert_eq!(resumed.summary.state, LegacyImportState::Complete);
    assert_eq!(resumed.summary.artifacts.imported, 1);
}

#[test]
fn a_pending_legacy_artifact_reservation_cannot_be_published_by_another_import() {
    let temporary = TempDir::new().expect("temporary directory");
    let source = temporary.path().join("legacy");
    let source_path = source.join("videos/source.mp4");
    fs::create_dir_all(source_path.parent().expect("source parent"))
        .expect("create source directory");
    let bytes = b"pending-legacy-video";
    fs::write(&source_path, bytes).expect("write source artifact");
    let source_root = SourceRoot::open(&source).expect("open source root");
    let artifact = PlannedArtifact {
        source_path,
        kind: artifact_kind("videos/source.mp4"),
        extension: "mp4".to_owned(),
        content_hash: ContentHash::digest(bytes),
        size_bytes: u64::try_from(bytes.len()).expect("fixture size"),
    };
    let database =
        Database::open(temporary.path().join("native/db/osg.sqlite3")).expect("open database");
    let draft = ArtifactDraft::new(
        ArtifactKind::new(artifact.kind).expect("artifact kind"),
        artifact.content_hash,
        artifact.size_bytes,
        json!({
            "source": "electronRootV1",
            "extension": artifact.extension.clone(),
        }),
    )
    .expect("artifact draft");
    let ArtifactRegistration::Staging(staging) = database
        .register_artifact(&draft)
        .expect("reserve competing publication")
    else {
        panic!("fresh artifact must stage");
    };
    let artifact_id = staging.record().id();

    assert!(matches!(
        publish_artifact(&database, &source_root, &artifact),
        Err(DatabaseError::ArtifactPublicationInProgress(id)) if id == artifact_id
    ));
    assert_eq!(
        database
            .get_artifact(artifact_id)
            .expect("read reservation")
            .expect("reservation remains")
            .state(),
        ArtifactState::Pending
    );
    database
        .mark_artifact_failed(
            artifact_id,
            &ArtifactFailureCode::new("testCleanup").expect("failure code"),
        )
        .expect("clean up reservation");
}

#[test]
fn handle_identity_detects_a_path_replaced_after_open() {
    let temporary = TempDir::new().expect("temporary directory");
    let source = temporary.path().join("legacy");
    fs::create_dir_all(source.join("videos")).expect("create source");
    let path = source.join("videos/source.mp4");
    fs::write(&path, b"original").expect("write source");
    let root = SourceRoot::open(&source).expect("open source root");
    let opened = open_source_file(&root, &path).expect("open validated source");
    let displaced = source.join("videos/displaced.mp4");
    fs::rename(&path, &displaced).expect("move opened source");
    fs::write(&path, b"original").expect("replace with equal content");

    assert!(matches!(
        verify_source_path(&root, &path, &opened.identity, false),
        Err(PlanningError::Invalid)
    ));
}

#[test]
fn exact_digest_rejects_growth_beyond_the_advertised_size() {
    let temporary = TempDir::new().expect("temporary directory");
    let path = temporary.path().join("growing.bin");
    fs::write(&path, b"1234").expect("write original file");
    let mut file = File::open(&path).expect("open file");
    let expected_size = file.metadata().expect("metadata").len();
    fs::write(&path, b"12345").expect("grow file");

    assert!(matches!(
        digest_exact(&mut file, expected_size),
        Err(PlanningError::Invalid)
    ));
}

#[test]
fn symlinked_entries_cannot_escape_the_selected_root() {
    let temporary = TempDir::new().expect("temporary directory");
    let source = temporary.path().join("legacy");
    let outside = temporary.path().join("outside");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&outside).expect("create outside directory");
    fs::write(outside.join("private.mp4"), b"outside").expect("write outside file");

    let link = source.join("videos");
    let link_result = create_directory_symlink(&outside, &link);
    if cfg!(windows)
        && link_result.as_ref().is_err_and(|error| {
            error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314)
        })
    {
        return;
    }
    link_result.expect("create directory symlink");
    assert!(matches!(
        plan_legacy_root(&source),
        Err(PlanningError::Invalid)
    ));
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

#[test]
fn concurrent_in_process_imports_are_rejected_until_the_guard_drops() {
    let first = ImportGuard::acquire().expect("acquire first import guard");
    assert!(ImportGuard::acquire().is_err());
    drop(first);
    assert!(ImportGuard::acquire().is_ok());
}

#[test]
fn process_lock_rejects_a_second_import_and_releases_on_drop() {
    let temporary = TempDir::new().expect("temporary directory");
    let path = temporary.path().join("import.lock");
    let first = acquire_import_file_lock(&path).expect("acquire first process lock");
    assert!(acquire_import_file_lock(&path).is_err());
    drop(first);
    assert!(acquire_import_file_lock(&path).is_ok());
}

#[test]
fn invalid_roots_and_oversized_storage_are_rejected_before_database_work() {
    let temporary = TempDir::new().expect("temporary directory");
    let file = temporary.path().join("not-a-directory");
    fs::write(&file, b"nope").expect("write file");
    assert!(matches!(
        plan_legacy_root(&file),
        Err(PlanningError::Invalid)
    ));

    let source = temporary.path().join("oversized");
    fs::create_dir_all(&source).expect("create source");
    let storage = File::create(source.join("localStorage.json")).expect("create storage");
    storage
        .set_len(MAX_LOCAL_STORAGE_BYTES + 1)
        .expect("extend storage");
    assert!(matches!(
        plan_legacy_root(&source),
        Err(PlanningError::TooLarge)
    ));
}

#[test]
fn oversized_and_location_bearing_settings_are_never_persisted() {
    let planned = plan_storage_items(BTreeMap::from([
        (
            "oversized_preference".to_owned(),
            Value::String("x".repeat(MAX_LEGACY_SETTING_JSON_BYTES)),
        ),
        (
            "download_output_path".to_owned(),
            Value::String(r"C:\Users\private\Videos".to_owned()),
        ),
    ]))
    .expect("plan bounded settings");

    assert_eq!(planned.len(), 2);
    assert!(planned.iter().all(|item| {
        item.candidate.kind() == LegacyImportItemKind::Ignored
            && matches!(item.work, ImportWork::Ignored(_))
    }));
    assert!(is_transient_setting_key("download_output_path"));
    assert!(is_transient_setting_key("provider_file_url"));
    assert!(is_transient_setting_key("gemini_active_key_index"));
    assert!(is_transient_setting_key("osg.nativeNarrationAlignment.v1"));
    assert!(is_transient_setting_key("osg.nativeNarrationJob.v1"));
    assert!(is_transient_setting_key("osg.nativeJobIds.v1"));
    assert!(is_project_scoped_setting_key("original_subtitles_map"));
}

#[test]
fn nested_json_urls_paths_and_provider_handles_are_never_planned_as_settings() {
    let planned = plan_storage_items(BTreeMap::from([
        ("theme".to_owned(), Value::String("dark".to_owned())),
        (
            "safe_layout".to_owned(),
            Value::String(r#"{"scale":1,"compact":true}"#.to_owned()),
        ),
        (
            "youtube_url_history".to_owned(),
            Value::String(
                r#"[{"id":"AbCdEfGhI_1","url":"https://www.youtube.com/watch?v=AbCdEfGhI_1"}]"#
                    .to_owned(),
            ),
        ),
        (
            "customModels".to_owned(),
            Value::String(
                r#"[{"name":"unsafe","modelUrl":"https://example.invalid/model","vocabPath":"C:\\private\\vocab.txt"}]"#
                    .to_owned(),
            ),
        ),
    ]))
    .expect("plan bounded settings");

    let settings = planned
        .iter()
        .filter_map(|item| match &item.work {
            ImportWork::Setting { key, .. } => Some(key.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(settings, ["safe_layout", "theme"]);
    assert_eq!(
        planned
            .iter()
            .filter(|item| matches!(item.work, ImportWork::Ignored(_)))
            .count(),
        2
    );
}
