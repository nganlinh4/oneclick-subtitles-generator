use std::sync::Mutex;

use secrecy::{ExposeSecret, SecretString};
use uuid::Version;

use super::*;

#[test]
fn credential_ids_are_uuid_v7() {
    assert_eq!(
        CredentialId::new().as_uuid().get_version(),
        Some(Version::SortRand)
    );
}

#[test]
fn session_credentials_round_trip_without_exposing_the_value() {
    let vault = CredentialVault::new(SessionCredentialBackend::new());
    let secret = SecretString::from("gemini-key-1234");
    let id = CredentialId::new();

    vault.set(id, &secret).expect("credential should be stored");

    assert_eq!(
        credential_last_four(CredentialPurpose::GeminiApiKey, &secret).expect("derive safe suffix"),
        "1234"
    );
    assert_eq!(
        vault
            .resolve(id)
            .expect("credential should resolve")
            .expose_secret(),
        secret.expose_secret()
    );
}

#[test]
fn accounts_use_the_fixed_service_and_uuid_format() {
    let backend = RecordingBackend::default();
    let vault = CredentialVault::new(&backend);
    let id = CredentialId::from_uuid(
        Uuid::parse_str("018f4c22-f0f1-7c09-a4d5-120d7b6f84a1").expect("valid uuid"),
    )
    .expect("valid UUIDv7");

    vault
        .set(id, &SecretString::from("abcd1234"))
        .expect("credential should be stored");

    let calls = backend.calls.lock().expect("call log should be available");
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|call| {
        call.service == CREDENTIAL_SERVICE
            && call.account == "credential/018f4c22-f0f1-7c09-a4d5-120d7b6f84a1"
    }));
}

#[test]
fn a_write_is_rejected_and_removed_when_round_trip_verification_differs() {
    let backend = CorruptingBackend::default();
    let vault = CredentialVault::new(&backend);
    let result = vault.set(CredentialId::new(), &SecretString::from("expected-secret"));

    assert_eq!(result, Err(CredentialError::VerificationFailed));
    assert!(backend.deleted.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn locked_and_unavailable_errors_remain_distinct() {
    for error in [CredentialError::Locked, CredentialError::Unavailable] {
        let vault = CredentialVault::new(FailingBackend(error));
        assert_eq!(
            vault.availability().expect("known availability state"),
            match error {
                CredentialError::Locked => CredentialStoreAvailability::Locked,
                CredentialError::Unavailable => CredentialStoreAvailability::Unavailable,
                _ => unreachable!(),
            }
        );
        assert_eq!(
            vault.set(CredentialId::new(), &SecretString::from("secret")),
            Err(error)
        );
    }
}

#[test]
fn deleting_a_session_credential_removes_it_from_memory() {
    let vault = CredentialVault::new(SessionCredentialBackend::new());
    let id = CredentialId::new();
    vault
        .set(id, &SecretString::from("temporary-secret"))
        .expect("credential should be stored");

    vault.delete(id).expect("credential should be deleted");

    assert!(matches!(vault.resolve(id), Err(CredentialError::NotFound)));
    assert!(
        vault
            .inspect(id)
            .expect("keyring should be readable")
            .is_none()
    );
}

#[test]
fn unicode_last_four_is_character_safe() {
    assert_eq!(last_four("token-한글🔑끝"), "한글🔑끝");
}

#[test]
fn purposes_derive_the_only_valid_provider() {
    let id = CredentialId::new();
    let status = CredentialStatus::pending(id, CredentialPurpose::YouTubeOauthClient);

    assert_eq!(status.provider(), CredentialProvider::YouTube);
    assert_eq!(
        serde_json::to_value(status).expect("serialize safe metadata"),
        serde_json::json!({
            "id": id,
            "purpose": "youtubeOauthClient",
            "provider": "youtube",
            "state": "pending",
            "last4": null
        })
    );
}

#[test]
fn set_requests_reject_legacy_or_mismatched_provider_fields() {
    let mismatched = r#"{
            "purpose":"geminiApiKey",
            "provider":"youtube",
            "secret":"secret"
        }"#;
    let legacy = r#"{"provider":"gemini","secret":"secret"}"#;

    assert!(serde_json::from_str::<CredentialSetRequest>(mismatched).is_err());
    assert!(serde_json::from_str::<CredentialSetRequest>(legacy).is_err());
}

#[test]
fn youtube_oauth_clients_require_an_atomic_typed_pair() {
    let valid = SecretString::from(
        r#"{"clientId":"client.apps.googleusercontent.com","clientSecret":"secret-9876"}"#,
    );
    let incomplete = SecretString::from(r#"{"clientId":"client-only"}"#);
    let unknown = SecretString::from(
        r#"{"clientId":"client","clientSecret":"secret","refreshToken":"nope"}"#,
    );

    assert_eq!(
        credential_last_four(CredentialPurpose::YouTubeOauthClient, &valid)
            .expect("valid OAuth client"),
        "9876"
    );
    assert_eq!(
        validate_credential(CredentialPurpose::YouTubeOauthClient, &incomplete),
        Err(CredentialError::InvalidCredential)
    );
    assert_eq!(
        validate_credential(CredentialPurpose::YouTubeOauthClient, &unknown),
        Err(CredentialError::InvalidCredential)
    );
}

#[test]
fn youtube_oauth_tokens_require_refreshable_bounded_vault_payloads() {
    let valid = SecretString::from(
        r#"{"accessToken":"access-value","refreshToken":"refresh-4321","expiresAtUnixMs":9999999999999}"#,
    );
    let missing_refresh = SecretString::from(
        r#"{"accessToken":"access-value","refreshToken":"","expiresAtUnixMs":9999999999999}"#,
    );
    let unknown = SecretString::from(
        r#"{"accessToken":"access-value","refreshToken":"refresh","expiresAtUnixMs":9999999999999,"scope":"secret"}"#,
    );

    assert_eq!(
        credential_last_four(CredentialPurpose::YouTubeOauthToken, &valid)
            .expect("valid OAuth token"),
        "4321"
    );
    assert_eq!(
        validate_credential(CredentialPurpose::YouTubeOauthToken, &missing_refresh),
        Err(CredentialError::InvalidCredential)
    );
    assert_eq!(
        validate_credential(CredentialPurpose::YouTubeOauthToken, &unknown),
        Err(CredentialError::InvalidCredential)
    );
}

#[test]
fn non_v7_credential_ids_are_rejected_at_the_ipc_boundary() {
    let v4 = Uuid::new_v4();
    let input = serde_json::to_string(&v4).expect("serialize test UUID");

    assert!(serde_json::from_str::<CredentialId>(&input).is_err());
    assert!(CredentialId::from_uuid(v4).is_err());
}

#[test]
fn empty_credentials_never_reach_the_backend() {
    let backend = RecordingBackend::default();
    let vault = CredentialVault::new(&backend);

    assert_eq!(
        vault.set(CredentialId::new(), &SecretString::default()),
        Err(CredentialError::EmptySecret)
    );
    assert!(
        backend
            .calls
            .lock()
            .expect("call log should lock")
            .is_empty()
    );
}

#[derive(Debug)]
struct Call {
    service: String,
    account: String,
}

#[derive(Default)]
struct RecordingBackend {
    calls: Mutex<Vec<Call>>,
    secret: Mutex<Option<SecretString>>,
}

impl CredentialBackend for &RecordingBackend {
    fn ensure_available(&self) -> Result<(), CredentialError> {
        Ok(())
    }

    fn set(
        &self,
        service: &str,
        account: &str,
        secret: &SecretString,
    ) -> Result<(), CredentialError> {
        self.calls.lock().expect("call log should lock").push(Call {
            service: service.to_owned(),
            account: account.to_owned(),
        });
        self.secret
            .lock()
            .expect("secret should lock")
            .replace(secret.clone());
        Ok(())
    }

    fn get(&self, service: &str, account: &str) -> Result<SecretString, CredentialError> {
        self.calls.lock().expect("call log should lock").push(Call {
            service: service.to_owned(),
            account: account.to_owned(),
        });
        self.secret
            .lock()
            .expect("secret should lock")
            .clone()
            .ok_or(CredentialError::NotFound)
    }

    fn delete(&self, _service: &str, _account: &str) -> Result<(), CredentialError> {
        Ok(())
    }
}

#[derive(Default)]
struct CorruptingBackend {
    deleted: std::sync::atomic::AtomicBool,
}

impl CredentialBackend for &CorruptingBackend {
    fn ensure_available(&self) -> Result<(), CredentialError> {
        Ok(())
    }

    fn set(
        &self,
        _service: &str,
        _account: &str,
        _secret: &SecretString,
    ) -> Result<(), CredentialError> {
        Ok(())
    }

    fn get(&self, _service: &str, _account: &str) -> Result<SecretString, CredentialError> {
        Ok(SecretString::from("different-secret"))
    }

    fn delete(&self, _service: &str, _account: &str) -> Result<(), CredentialError> {
        self.deleted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

struct FailingBackend(CredentialError);

impl CredentialBackend for FailingBackend {
    fn ensure_available(&self) -> Result<(), CredentialError> {
        Err(self.0)
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
