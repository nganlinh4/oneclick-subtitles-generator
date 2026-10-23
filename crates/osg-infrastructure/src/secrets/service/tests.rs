use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use secrecy::{ExposeSecret, SecretString};
use tempfile::TempDir;

use super::*;
use crate::secrets::{
    CREDENTIAL_SERVICE, CredentialError, CredentialProvider, SessionCredentialBackend,
};

fn database() -> (TempDir, Database) {
    let directory = TempDir::new().expect("temporary directory");
    let database =
        Database::open(directory.path().join("db/osg.sqlite3")).expect("open migrated database");
    (directory, database)
}

#[test]
fn multiple_gemini_credentials_round_trip_with_metadata_only() {
    let (directory, database) = database();
    let backend = Arc::new(SessionCredentialBackend::new());
    let service = CredentialService::new(database, Arc::clone(&backend));

    let first = service
        .set(CredentialSetRequest::new(
            CredentialPurpose::GeminiApiKey,
            "first-gemini-secret-1111".to_owned(),
        ))
        .expect("store first credential");
    let second = service
        .set(CredentialSetRequest::new(
            CredentialPurpose::GeminiApiKey,
            "second-gemini-secret-2222".to_owned(),
        ))
        .expect("store second credential");

    assert_ne!(first.id, second.id);
    let report = service
        .status(Some(CredentialPurpose::GeminiApiKey))
        .expect("credential status");
    assert_eq!(report.store, CredentialStoreAvailability::Available);
    assert_eq!(report.credentials.len(), 2);
    assert!(
        report
            .credentials
            .iter()
            .all(|status| status.state == CredentialState::Ready)
    );
    let serialized = serde_json::to_string(&report).expect("serialize safe status");
    assert!(!serialized.contains("first-gemini-secret"));
    assert!(!serialized.contains("second-gemini-secret"));
    assert_eq!(
        service
            .resolve(first.id, CredentialPurpose::GeminiApiKey)
            .expect("resolve internally")
            .expose_secret(),
        "first-gemini-secret-1111"
    );
    let backup = directory.path().join("backup/credentials.sqlite3");
    service
        .database()
        .backup_to(&backup)
        .expect("back up credential metadata");
    let database_bytes = std::fs::read(backup).expect("read database backup");
    assert!(!contains_bytes(
        &database_bytes,
        b"first-gemini-secret-1111"
    ));
    assert!(!contains_bytes(
        &database_bytes,
        b"second-gemini-secret-2222"
    ));
}

#[test]
fn status_repairs_a_crash_between_keyring_write_and_ready_transition() {
    let (_directory, database) = database();
    let backend = Arc::new(SessionCredentialBackend::new());
    let id = CredentialId::new();
    database
        .credential_insert_pending(id, CredentialPurpose::GeminiApiKey)
        .expect("insert pending metadata");
    backend
        .set(
            CREDENTIAL_SERVICE,
            &id.account(),
            &SecretString::from("recovered-secret-9876"),
        )
        .expect("simulate completed keyring write");
    let service = CredentialService::new(database, backend);

    let report = service
        .status(Some(CredentialPurpose::GeminiApiKey))
        .expect("reconcile status");

    assert_eq!(report.credentials.len(), 1);
    assert_eq!(report.credentials[0].state, CredentialState::Ready);
    assert_eq!(report.credentials[0].last4.as_deref(), Some("9876"));
}

#[test]
fn resolving_with_the_wrong_purpose_is_rejected_before_keyring_access() {
    let (_directory, database) = database();
    let service = CredentialService::new(database, SessionCredentialBackend::new());
    let status = service
        .set(CredentialSetRequest::new(
            CredentialPurpose::GeminiApiKey,
            "gemini-secret-1234".to_owned(),
        ))
        .expect("store Gemini key");

    assert!(matches!(
        service.resolve(status.id, CredentialPurpose::YouTubeApiKey),
        Err(CredentialServiceError::Credential(
            CredentialError::PurposeMismatch
        ))
    ));
}

#[test]
fn singleton_purposes_reject_a_second_credential() {
    let (_directory, database) = database();
    let service = CredentialService::new(database, SessionCredentialBackend::new());
    service
        .set(CredentialSetRequest::new(
            CredentialPurpose::GeniusAccessToken,
            "first-genius-token".to_owned(),
        ))
        .expect("store singleton token");

    assert!(matches!(
        service.set(CredentialSetRequest::new(
            CredentialPurpose::GeniusAccessToken,
            "second-genius-token".to_owned(),
        )),
        Err(CredentialServiceError::Database(
            crate::storage::DatabaseError::CredentialPurposeAlreadyExists(
                CredentialPurpose::GeniusAccessToken
            )
        ))
    ));
}

#[test]
fn youtube_oauth_client_is_atomic_and_only_exposes_the_secret_suffix() {
    let (directory, database) = database();
    let service = CredentialService::new(database, SessionCredentialBackend::new());
    let payload = r#"{"clientId":"private-client-id","clientSecret":"private-secret-2468"}"#;

    let status = service
        .set(CredentialSetRequest::new(
            CredentialPurpose::YouTubeOauthClient,
            payload.to_owned(),
        ))
        .expect("store OAuth client pair");

    assert_eq!(status.provider(), CredentialProvider::YouTube);
    assert_eq!(status.last4.as_deref(), Some("2468"));
    let serialized = serde_json::to_string(&status).expect("serialize safe status");
    assert!(!serialized.contains("private-client-id"));
    assert!(!serialized.contains("private-secret"));

    let backup = directory.path().join("backup/oauth.sqlite3");
    service
        .database()
        .backup_to(&backup)
        .expect("back up metadata");
    let bytes = std::fs::read(backup).expect("read backup");
    assert!(!contains_bytes(&bytes, b"private-client-id"));
    assert!(!contains_bytes(&bytes, b"private-secret-2468"));
}

#[test]
fn singleton_upsert_keeps_the_opaque_id_and_replaces_only_the_keyring_value() {
    let (directory, database) = database();
    let service = CredentialService::new(database, SessionCredentialBackend::new());
    let first = service
        .upsert(CredentialSetRequest::new(
            CredentialPurpose::YouTubeOauthToken,
            r#"{"accessToken":"first-access","refreshToken":"first-refresh-1111","expiresAtUnixMs":9999999999999}"#.to_owned(),
        ))
        .expect("store token");
    let second = service
        .upsert(CredentialSetRequest::new(
            CredentialPurpose::YouTubeOauthToken,
            r#"{"accessToken":"second-access","refreshToken":"second-refresh-2222","expiresAtUnixMs":9999999999999}"#.to_owned(),
        ))
        .expect("replace token");

    assert_eq!(first.id, second.id);
    assert_eq!(second.last4.as_deref(), Some("2222"));
    assert_eq!(
        service
            .resolve(second.id, CredentialPurpose::YouTubeOauthToken)
            .expect("resolve current token")
            .expose_secret(),
        r#"{"accessToken":"second-access","refreshToken":"second-refresh-2222","expiresAtUnixMs":9999999999999}"#
    );
    let backup = directory.path().join("backup/oauth-token.sqlite3");
    service.database().backup_to(&backup).expect("backup");
    let bytes = std::fs::read(backup).expect("read backup");
    assert!(!contains_bytes(&bytes, b"second-access"));
    assert!(!contains_bytes(&bytes, b"second-refresh"));
}

#[test]
fn selected_multi_credential_is_replaced_in_place() {
    let (_directory, database) = database();
    let service = CredentialService::new(database, SessionCredentialBackend::new());
    let first = service
        .set(CredentialSetRequest::new(
            CredentialPurpose::GeminiApiKey,
            "gemini-first-1111".to_owned(),
        ))
        .expect("store first key");
    let untouched = service
        .set(CredentialSetRequest::new(
            CredentialPurpose::GeminiApiKey,
            "gemini-second-2222".to_owned(),
        ))
        .expect("store second key");

    let replaced = service
        .replace(
            first.id,
            CredentialSetRequest::new(
                CredentialPurpose::GeminiApiKey,
                "gemini-replacement-3333".to_owned(),
            ),
        )
        .expect("replace selected key");

    assert_eq!(replaced.id, first.id);
    assert_eq!(replaced.last4.as_deref(), Some("3333"));
    assert_eq!(
        service
            .resolve(untouched.id, CredentialPurpose::GeminiApiKey)
            .expect("resolve untouched key")
            .expose_secret(),
        "gemini-second-2222"
    );
}

#[test]
fn status_marks_a_pending_reference_without_a_keyring_value_unavailable() {
    let (_directory, database) = database();
    let id = CredentialId::new();
    database
        .credential_insert_pending(id, CredentialPurpose::YouTubeApiKey)
        .expect("insert pending reference");
    let service = CredentialService::new(database, SessionCredentialBackend::new());

    let report = service.status(None).expect("reconcile missing value");

    assert_eq!(report.credentials[0].state, CredentialState::Unavailable);
}

#[test]
fn singleton_upsert_repairs_an_unavailable_keyring_value_in_place() {
    let (_directory, database) = database();
    let id = CredentialId::new();
    database
        .credential_insert_pending(id, CredentialPurpose::YouTubeApiKey)
        .expect("insert pending reference");
    let service = CredentialService::new(database, SessionCredentialBackend::new());
    assert_eq!(
        service
            .status(Some(CredentialPurpose::YouTubeApiKey))
            .expect("reconcile missing value")
            .credentials[0]
            .state,
        CredentialState::Unavailable
    );

    let repaired = service
        .upsert(CredentialSetRequest::new(
            CredentialPurpose::YouTubeApiKey,
            "replacement-youtube-key-9876".to_owned(),
        ))
        .expect("repair singleton");

    assert_eq!(repaired.id, id);
    assert_eq!(repaired.state, CredentialState::Ready);
    assert_eq!(repaired.last4.as_deref(), Some("9876"));
    assert_eq!(
        service
            .resolve(id, CredentialPurpose::YouTubeApiKey)
            .expect("resolve repaired value")
            .expose_secret(),
        "replacement-youtube-key-9876"
    );
}

#[test]
fn failed_keyring_delete_preserves_metadata() {
    let (_directory, database) = database();
    let backend = Arc::new(DeleteFailingBackend::default());
    let service = CredentialService::new(database, Arc::clone(&backend));
    let status = service
        .set(CredentialSetRequest::new(
            CredentialPurpose::GeniusAccessToken,
            "genius-secret".to_owned(),
        ))
        .expect("store credential");
    backend.fail_delete.store(true, Ordering::SeqCst);

    assert!(service.delete(status.id).is_err());
    assert_eq!(
        service
            .database()
            .credential_list(None)
            .expect("metadata remains")
            .len(),
        1
    );
}

#[test]
fn invalid_input_is_rejected_before_metadata_is_created() {
    let (_directory, database) = database();
    let service = CredentialService::new(database, SessionCredentialBackend::new());

    let result = service.set(CredentialSetRequest::new(
        CredentialPurpose::GeminiApiKey,
        String::new(),
    ));

    assert!(matches!(
        result,
        Err(CredentialServiceError::Credential(
            CredentialError::EmptySecret
        ))
    ));
    assert!(
        service
            .database()
            .credential_list(None)
            .expect("list metadata")
            .is_empty()
    );
}

#[test]
fn failed_keyring_write_is_cleaned_up_and_singleton_can_retry() {
    let (_directory, database) = database();
    let backend = Arc::new(SetFailingBackend::default());
    let service = CredentialService::new(database, Arc::clone(&backend));

    assert!(matches!(
        service.set(CredentialSetRequest::new(
            CredentialPurpose::YouTubeApiKey,
            "youtube-secret-1234".to_owned(),
        )),
        Err(CredentialServiceError::Credential(
            CredentialError::BackendFailure
        ))
    ));
    assert!(
        service
            .database()
            .credential_list(None)
            .expect("list metadata after cleanup")
            .is_empty()
    );

    backend.fail_set.store(false, Ordering::SeqCst);
    let status = service
        .set(CredentialSetRequest::new(
            CredentialPurpose::YouTubeApiKey,
            "youtube-secret-1234".to_owned(),
        ))
        .expect("retry singleton credential");
    assert_eq!(status.state, CredentialState::Ready);
}

#[test]
fn unavailable_platform_store_still_returns_persisted_status() {
    let (_directory, database) = database();
    let id = CredentialId::new();
    database
        .credential_insert_pending(id, CredentialPurpose::YouTubeApiKey)
        .expect("insert pending metadata");
    let service = CredentialService::new(database, UnavailableBackend);

    let report = service.status(None).expect("status remains readable");

    assert_eq!(report.store, CredentialStoreAvailability::Unavailable);
    assert_eq!(report.credentials.len(), 1);
    assert_eq!(report.credentials[0].id, id);
}

#[derive(Default)]
struct DeleteFailingBackend {
    secret: std::sync::Mutex<Option<SecretString>>,
    fail_delete: AtomicBool,
}

impl CredentialBackend for DeleteFailingBackend {
    fn ensure_available(&self) -> Result<(), CredentialError> {
        Ok(())
    }

    fn set(
        &self,
        _service: &str,
        _account: &str,
        secret: &SecretString,
    ) -> Result<(), CredentialError> {
        self.secret
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?
            .replace(secret.clone());
        Ok(())
    }

    fn get(&self, _service: &str, _account: &str) -> Result<SecretString, CredentialError> {
        self.secret
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?
            .clone()
            .ok_or(CredentialError::NotFound)
    }

    fn delete(&self, _service: &str, _account: &str) -> Result<(), CredentialError> {
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(CredentialError::BackendFailure);
        }
        self.secret
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?
            .take();
        Ok(())
    }
}

struct UnavailableBackend;

impl CredentialBackend for UnavailableBackend {
    fn ensure_available(&self) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }

    fn set(
        &self,
        _service: &str,
        _account: &str,
        _secret: &SecretString,
    ) -> Result<(), CredentialError> {
        unreachable!("availability is checked before setting")
    }

    fn get(&self, _service: &str, _account: &str) -> Result<SecretString, CredentialError> {
        unreachable!("availability is checked before reading")
    }

    fn delete(&self, _service: &str, _account: &str) -> Result<(), CredentialError> {
        unreachable!("availability is checked before deleting")
    }
}

struct SetFailingBackend {
    secret: std::sync::Mutex<Option<SecretString>>,
    fail_set: AtomicBool,
}

impl Default for SetFailingBackend {
    fn default() -> Self {
        Self {
            secret: std::sync::Mutex::new(None),
            fail_set: AtomicBool::new(true),
        }
    }
}

impl CredentialBackend for SetFailingBackend {
    fn ensure_available(&self) -> Result<(), CredentialError> {
        Ok(())
    }

    fn set(
        &self,
        _service: &str,
        _account: &str,
        secret: &SecretString,
    ) -> Result<(), CredentialError> {
        self.secret
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?
            .replace(secret.clone());
        if self.fail_set.load(Ordering::SeqCst) {
            Err(CredentialError::BackendFailure)
        } else {
            Ok(())
        }
    }

    fn get(&self, _service: &str, _account: &str) -> Result<SecretString, CredentialError> {
        self.secret
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?
            .clone()
            .ok_or(CredentialError::NotFound)
    }

    fn delete(&self, _service: &str, _account: &str) -> Result<(), CredentialError> {
        self.secret
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?
            .take();
        Ok(())
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}
