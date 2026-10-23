//! Scoped settings: typed round trips, batches, bounded deletes, scope clears, and key validation.

use super::*;

#[test]
fn settings_round_trip_as_typed_json() {
    let (_directory, database) = database();
    let expected = json!({"model": "gemini-2.5-flash", "temperature": 0.2});

    database
        .put_setting("app", "gemini.defaults", &expected)
        .expect("save setting");

    assert_eq!(
        database
            .get_setting("app", "gemini.defaults")
            .expect("load setting"),
        Some(expected)
    );
    assert!(
        database
            .delete_setting("app", "gemini.defaults")
            .expect("delete setting")
    );
    assert_eq!(
        database
            .get_setting("app", "gemini.defaults")
            .expect("load missing setting"),
        None
    );
}

#[test]
fn batch_settings_are_atomic_and_sorted() {
    let (_directory, database) = database();
    let values = BTreeMap::from([
        ("theme".to_owned(), json!("dark")),
        ("locale".to_owned(), json!("vi")),
    ]);

    database
        .put_settings("app", &values)
        .expect("save settings batch");

    assert_eq!(
        database.list_settings("app").expect("list settings"),
        values
    );
}

#[test]
fn batch_settings_reject_excessive_entry_count_and_aggregate_bytes() {
    let (_directory, database) = database();
    let too_many = (0..=crate::storage::actor::MAX_SETTINGS_BATCH_ENTRIES)
        .map(|index| (format!("setting.{index}"), json!(true)))
        .collect::<BTreeMap<_, _>>();
    assert!(matches!(
        database.put_settings("app", &too_many),
        Err(crate::storage::actor::DatabaseError::SettingTooLarge)
    ));

    let value = "x".repeat(crate::storage::actor::MAX_SETTING_BYTES - 2);
    let oversized = (0..9)
        .map(|index| (format!("large.{index}"), json!(value.clone())))
        .collect::<BTreeMap<_, _>>();
    assert!(matches!(
        database.put_settings("app", &oversized),
        Err(crate::storage::actor::DatabaseError::SettingTooLarge)
    ));
    assert!(
        database
            .list_settings("app")
            .expect("empty scope")
            .is_empty()
    );
}

#[test]
fn batch_setting_delete_is_exact_bounded_and_never_reads_values() {
    let (_directory, database) = database();
    database
        .put_setting(
            "legacy",
            "provider.cache.first",
            &json!("opaque-capability"),
        )
        .expect("first transient");
    database
        .put_setting("legacy", "provider.cache.second", &json!("provider-uri"))
        .expect("second transient");
    database
        .put_setting("legacy", "keep", &json!(true))
        .expect("durable setting");

    assert_eq!(
        database
            .delete_settings(
                "legacy",
                &[
                    "provider.cache.first".to_owned(),
                    "provider.cache.second".to_owned(),
                    "provider.cache.first".to_owned(),
                ],
            )
            .expect("delete exact transient keys"),
        2
    );
    assert_eq!(
        database.list_settings("legacy").expect("remaining"),
        BTreeMap::from([("keep".to_owned(), json!(true))])
    );
    assert!(
        database
            .delete_settings("legacy", &["provider.cache.%".to_owned()])
            .is_err()
    );
    assert!(
        database
            .delete_settings(
                "legacy",
                &vec!["key".to_owned(); crate::storage::actor::MAX_SETTING_DELETE_KEYS + 1]
            )
            .is_err()
    );
}

#[test]
fn clearing_one_setting_scope_is_atomic_and_does_not_touch_another_scope() {
    let (_directory, database) = database();
    database
        .put_settings(
            "app",
            &BTreeMap::from([
                ("language".to_owned(), json!("ko")),
                ("theme".to_owned(), json!("dark")),
            ]),
        )
        .expect("app settings");
    database
        .put_setting("project", "theme", &json!("light"))
        .expect("other scope");

    assert_eq!(database.clear_settings("app").expect("clear app scope"), 2);
    assert!(database.list_settings("app").expect("empty app").is_empty());
    assert_eq!(
        database
            .get_setting("project", "theme")
            .expect("other scope retained"),
        Some(json!("light"))
    );
    assert_eq!(database.clear_settings("app").expect("idempotent clear"), 0);
    assert!(database.clear_settings("").is_err());
}

#[test]
fn rejects_unbounded_or_ambiguous_setting_keys() {
    let (_directory, database) = database();

    assert!(database.put_setting("", "key", &json!(true)).is_err());
    assert!(
        database
            .put_setting("app", "../../secret", &json!(true))
            .is_err()
    );
    for safe_key in [
        "gemini_model",
        "gemini_max_tokens",
        "maxTokens",
        "tokenCount",
        "theme",
        "keyboard_shortcuts",
    ] {
        database
            .put_setting("app", safe_key, &json!("keep"))
            .expect("non-secret setting");
    }
    for secret_key in [
        "gemini_api_key",
        "gemini_blacklisted_keys",
        "provider_refresh_token",
        "provider_credentials_v2",
        "provider_token",
        "clientSecret",
        "client.secret",
        "client:secret",
        "client..::--secret",
        "accessToken",
        "refreshToken",
        "privateKey",
        "apiKey",
        "APIKey",
        "oauthToken",
        "providerClientId",
        "providerAuthorization",
        "accountPassword",
        "accountPasswd",
        "accountPassphrase",
        "providerCredential",
        "sessionCookie",
        "browserCookies",
        "oauthJwt",
        "serviceAccessKey",
        "providerBearer",
        "accountSessionId",
        "accountSessionKey",
        "providerAuth",
        "providerAccessTokens",
        "providerRefreshTokens",
        "providerOauthTokens",
        "providerAuthTokens",
        "providerSecrets",
        "clientId",
        "accessKey",
        "bearer",
        "sessionId",
        "sessionKey",
        "auth",
        "token",
        "secret",
        "secretKey",
        "secrets",
        "cookie",
        "cookies",
        "jwt",
    ] {
        assert!(matches!(
            database.put_setting("app", secret_key, &json!("never-store")),
            Err(DatabaseError::SecretSetting)
        ));
    }
}
