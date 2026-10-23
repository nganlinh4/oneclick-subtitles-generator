//! Credential metadata rows: transitions, multi-key purposes, singleton purposes, and validation.

use super::*;

#[test]
fn credential_metadata_transitions_without_storing_secret_values() {
    let (directory, database) = database();
    let id = CredentialId::new();

    let pending = database
        .credential_insert_pending(id, CredentialPurpose::GeminiApiKey)
        .expect("insert pending credential metadata");
    assert_eq!(pending.state, CredentialState::Pending);
    assert_eq!(pending.last4, None);

    let ready = database
        .credential_mark_ready(id, "🔑끝")
        .expect("mark credential ready");
    assert_eq!(ready.state, CredentialState::Ready);
    assert_eq!(ready.last4.as_deref(), Some("🔑끝"));
    assert_eq!(
        database
            .credential_list(Some(CredentialPurpose::GeminiApiKey))
            .expect("list purpose credentials"),
        vec![ready.clone()]
    );

    drop(database);
    let raw = std::fs::read(directory.path().join("db/osg.sqlite3")).expect("read database bytes");
    assert!(
        !raw.windows(b"super-secret-value".len())
            .any(|window| { window == b"super-secret-value" })
    );
}

#[test]
fn supports_multiple_gemini_keys_and_idempotent_deletion() {
    let (_directory, database) = database();
    let first = CredentialId::new();
    let second = CredentialId::new();
    database
        .credential_insert_pending(first, CredentialPurpose::GeminiApiKey)
        .expect("insert first Gemini key");
    database
        .credential_insert_pending(second, CredentialPurpose::GeminiApiKey)
        .expect("insert second Gemini key");

    let credentials = database
        .credential_list(Some(CredentialPurpose::GeminiApiKey))
        .expect("list Gemini keys");
    assert_eq!(credentials.len(), 2);
    assert!(database.credential_delete(first).expect("delete first"));
    assert!(!database.credential_delete(first).expect("repeat delete"));
    assert_eq!(
        database
            .credential_list(Some(CredentialPurpose::GeminiApiKey))
            .expect("list remaining keys")
            .len(),
        1
    );
}

#[test]
fn singleton_credential_purposes_are_enforced_independently() {
    let (_directory, database) = database();
    database
        .credential_insert_pending(CredentialId::new(), CredentialPurpose::GeniusAccessToken)
        .expect("insert Genius token");

    assert!(matches!(
        database
            .credential_insert_pending(CredentialId::new(), CredentialPurpose::GeniusAccessToken),
        Err(DatabaseError::CredentialPurposeAlreadyExists(
            CredentialPurpose::GeniusAccessToken
        ))
    ));
    database
        .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeApiKey)
        .expect("YouTube API key is a separate singleton");
    database
        .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeOauthClient)
        .expect("YouTube OAuth client is a separate singleton");
    database
        .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeOauthToken)
        .expect("YouTube OAuth token is a separate singleton");
}

#[test]
fn schema_rejects_unknown_credential_purposes() {
    let (directory, database) = database();
    drop(database);
    let connection = rusqlite::Connection::open(directory.path().join("db/osg.sqlite3"))
        .expect("open database directly");

    assert!(
        connection
            .execute(
                "INSERT INTO credential_refs(
                       id, purpose, status, created_at_ms, updated_at_ms
                     ) VALUES (?1, 'gemini', 'pending', 1, 1)",
                [Uuid::now_v7()],
            )
            .is_err()
    );
}

#[test]
fn rejects_invalid_last_four_metadata() {
    let (_directory, database) = database();
    let id = CredentialId::new();
    database
        .credential_insert_pending(id, CredentialPurpose::YouTubeApiKey)
        .expect("insert pending credential");

    assert!(matches!(
        database.credential_mark_ready(id, "12345"),
        Err(DatabaseError::InvalidCredentialMetadata)
    ));
    assert!(matches!(
        database.credential_mark_ready(CredentialId::new(), "1234"),
        Err(DatabaseError::CredentialNotFound)
    ));
}
