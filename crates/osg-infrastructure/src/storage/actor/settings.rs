//! Scoped settings: actor requests, the `Database` API, and the settings table with secret-key
//! guards.

use std::collections::BTreeMap;
use std::sync::mpsc::SyncSender;

use osg_domain::ProjectId;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::{
    Database, MAX_SETTING_BYTES, MAX_SETTING_DELETE_KEYS, MAX_SETTINGS_BATCH_BYTES,
    MAX_SETTINGS_BATCH_ENTRIES, Request, now_ms,
};
use crate::storage::error::DatabaseError;
use crate::storage::projects;

pub(super) enum SettingsRequest {
    GetSetting {
        scope: String,
        key: String,
        reply: SyncSender<Result<Option<Value>, DatabaseError>>,
    },
    ListSettings {
        scope: String,
        reply: SyncSender<Result<BTreeMap<String, Value>, DatabaseError>>,
    },
    PutSetting {
        scope: String,
        key: String,
        value_json: String,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    PutProjectSetting {
        scope: String,
        key: String,
        value_json: String,
        project_id: ProjectId,
        expected_state_version: u64,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    PutSettings {
        scope: String,
        entries: Vec<(String, String)>,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    DeleteSetting {
        scope: String,
        key: String,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    DeleteSettings {
        scope: String,
        keys: Vec<String>,
        reply: SyncSender<Result<u64, DatabaseError>>,
    },
    ClearSettings {
        scope: String,
        reply: SyncSender<Result<u64, DatabaseError>>,
    },
}

impl std::fmt::Debug for SettingsRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::GetSetting { .. } => "GetSetting",
            Self::ListSettings { .. } => "ListSettings",
            Self::PutSetting { .. } => "PutSetting",
            Self::PutProjectSetting { .. } => "PutProjectSetting",
            Self::PutSettings { .. } => "PutSettings",
            Self::DeleteSetting { .. } => "DeleteSetting",
            Self::DeleteSettings { .. } => "DeleteSettings",
            Self::ClearSettings { .. } => "ClearSettings",
        })
    }
}

impl From<SettingsRequest> for Request {
    fn from(request: SettingsRequest) -> Self {
        Self::Settings(request)
    }
}

impl SettingsRequest {
    pub(super) fn handle(self, connection: &mut Connection) {
        match self {
            Self::GetSetting { scope, key, reply } => {
                let _ = reply.send(get_setting(connection, &scope, &key));
            }
            Self::ListSettings { scope, reply } => {
                let _ = reply.send(list_settings(connection, &scope));
            }
            Self::PutSetting {
                scope,
                key,
                value_json,
                reply,
            } => {
                let _ = reply.send(put_setting(connection, &scope, &key, &value_json));
            }
            Self::PutProjectSetting {
                scope,
                key,
                value_json,
                project_id,
                expected_state_version,
                reply,
            } => {
                let _ = reply.send(put_project_setting(
                    connection,
                    &scope,
                    &key,
                    &value_json,
                    project_id,
                    expected_state_version,
                ));
            }
            Self::PutSettings {
                scope,
                entries,
                reply,
            } => {
                let _ = reply.send(put_settings(connection, &scope, &entries));
            }
            Self::DeleteSetting { scope, key, reply } => {
                let _ = reply.send(delete_setting(connection, &scope, &key));
            }
            Self::DeleteSettings { scope, keys, reply } => {
                let _ = reply.send(delete_settings(connection, &scope, &keys));
            }
            Self::ClearSettings { scope, reply } => {
                let _ = reply.send(clear_settings(connection, &scope));
            }
        }
    }
}

impl Database {
    pub fn get_setting(&self, scope: &str, key: &str) -> Result<Option<Value>, DatabaseError> {
        validate_setting_key(scope, key)?;
        self.request(|reply| SettingsRequest::GetSetting {
            scope: scope.to_owned(),
            key: key.to_owned(),
            reply,
        })
    }

    pub fn list_settings(&self, scope: &str) -> Result<BTreeMap<String, Value>, DatabaseError> {
        validate_setting_part(scope)?;
        self.request(|reply| SettingsRequest::ListSettings {
            scope: scope.to_owned(),
            reply,
        })
    }

    pub fn put_setting(&self, scope: &str, key: &str, value: &Value) -> Result<(), DatabaseError> {
        validate_setting_key(scope, key)?;
        let value_json = serde_json::to_string(value)?;
        if value_json.len() > MAX_SETTING_BYTES {
            return Err(DatabaseError::SettingTooLarge);
        }
        self.request(|reply| SettingsRequest::PutSetting {
            scope: scope.to_owned(),
            key: key.to_owned(),
            value_json,
            reply,
        })
    }

    /// Stores a project-owned setting only while the exact project revision is current.
    ///
    /// The revision check and setting write share one `IMMEDIATE` transaction, so a project
    /// commit cannot slip between authorization and publication.
    pub fn put_project_setting(
        &self,
        scope: &str,
        key: &str,
        value: &Value,
        project_id: ProjectId,
        expected_state_version: u64,
    ) -> Result<(), DatabaseError> {
        validate_setting_key(scope, key)?;
        let value_json = serde_json::to_string(value)?;
        if value_json.len() > MAX_SETTING_BYTES {
            return Err(DatabaseError::SettingTooLarge);
        }
        self.request(|reply| SettingsRequest::PutProjectSetting {
            scope: scope.to_owned(),
            key: key.to_owned(),
            value_json,
            project_id,
            expected_state_version,
            reply,
        })
    }

    pub fn put_settings(
        &self,
        scope: &str,
        values: &BTreeMap<String, Value>,
    ) -> Result<(), DatabaseError> {
        validate_setting_part(scope)?;
        if values.len() > MAX_SETTINGS_BATCH_ENTRIES {
            return Err(DatabaseError::SettingTooLarge);
        }
        let mut entries = Vec::with_capacity(values.len());
        let mut total_bytes = 0_usize;
        for (key, value) in values {
            validate_setting_key(scope, key)?;
            let value_json = serde_json::to_string(value)?;
            if value_json.len() > MAX_SETTING_BYTES {
                return Err(DatabaseError::SettingTooLarge);
            }
            total_bytes = total_bytes
                .checked_add(key.len())
                .and_then(|size| size.checked_add(value_json.len()))
                .ok_or(DatabaseError::SettingTooLarge)?;
            if total_bytes > MAX_SETTINGS_BATCH_BYTES {
                return Err(DatabaseError::SettingTooLarge);
            }
            entries.push((key.clone(), value_json));
        }
        self.request(|reply| SettingsRequest::PutSettings {
            scope: scope.to_owned(),
            entries,
            reply,
        })
    }

    pub fn delete_setting(&self, scope: &str, key: &str) -> Result<bool, DatabaseError> {
        validate_setting_part(scope)?;
        validate_setting_part(key)?;
        self.request(|reply| SettingsRequest::DeleteSetting {
            scope: scope.to_owned(),
            key: key.to_owned(),
            reply,
        })
    }

    pub fn delete_settings(&self, scope: &str, keys: &[String]) -> Result<u64, DatabaseError> {
        validate_setting_part(scope)?;
        if keys.len() > MAX_SETTING_DELETE_KEYS {
            return Err(DatabaseError::InvalidSettingKey);
        }
        for key in keys {
            validate_setting_part(key)?;
        }
        self.request(|reply| SettingsRequest::DeleteSettings {
            scope: scope.to_owned(),
            keys: keys.to_vec(),
            reply,
        })
    }

    pub fn clear_settings(&self, scope: &str) -> Result<u64, DatabaseError> {
        validate_setting_part(scope)?;
        self.request(|reply| SettingsRequest::ClearSettings {
            scope: scope.to_owned(),
            reply,
        })
    }
}

fn get_setting(
    connection: &Connection,
    scope: &str,
    key: &str,
) -> Result<Option<Value>, DatabaseError> {
    let value_json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![scope, key],
            |row| row.get(0),
        )
        .optional()?;
    value_json
        .map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

fn list_settings(
    connection: &Connection,
    scope: &str,
) -> Result<BTreeMap<String, Value>, DatabaseError> {
    let mut statement = connection
        .prepare("SELECT key, value_json FROM app_settings WHERE scope = ?1 ORDER BY key")?;
    let rows = statement.query_map([scope], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut values = BTreeMap::new();
    for row in rows {
        let (key, value_json) = row?;
        values.insert(key, serde_json::from_str(&value_json)?);
    }
    Ok(values)
}

fn put_setting(
    connection: &mut Connection,
    scope: &str,
    key: &str,
    value_json: &str,
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms",
        params![scope, key, value_json, now_ms()],
    )?;
    transaction.commit()?;
    Ok(())
}

fn put_project_setting(
    connection: &mut Connection,
    scope: &str,
    key: &str,
    value_json: &str,
    project_id: ProjectId,
    expected_state_version: u64,
) -> Result<(), DatabaseError> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let project = projects::load_project(&transaction, project_id)?
        .ok_or(DatabaseError::ProjectNotFound(project_id))?;
    if project.state_version() != expected_state_version {
        return Err(DatabaseError::StaleProjectVersion {
            project_id,
            expected: expected_state_version,
            actual: project.state_version(),
        });
    }
    transaction.execute(
        "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms",
        params![scope, key, value_json, now_ms()],
    )?;
    transaction.commit()?;
    Ok(())
}

fn put_settings(
    connection: &mut Connection,
    scope: &str,
    entries: &[(String, String)],
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    {
        let mut statement = transaction.prepare(
            "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(scope, key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at_ms = excluded.updated_at_ms",
        )?;
        let updated_at_ms = now_ms();
        for (key, value_json) in entries {
            statement.execute(params![scope, key, value_json, updated_at_ms])?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn delete_setting(connection: &Connection, scope: &str, key: &str) -> Result<bool, DatabaseError> {
    let changed = connection.execute(
        "DELETE FROM app_settings WHERE scope = ?1 AND key = ?2",
        params![scope, key],
    )?;
    Ok(changed != 0)
}

fn delete_settings(
    connection: &mut Connection,
    scope: &str,
    keys: &[String],
) -> Result<u64, DatabaseError> {
    let transaction = connection.transaction()?;
    let mut removed = 0_u64;
    {
        let mut statement =
            transaction.prepare("DELETE FROM app_settings WHERE scope = ?1 AND key = ?2")?;
        for key in keys {
            let changed = statement.execute(params![scope, key])?;
            removed = removed
                .checked_add(u64::try_from(changed).unwrap_or(u64::MAX))
                .ok_or(DatabaseError::InvalidSettingKey)?;
        }
    }
    transaction.commit()?;
    Ok(removed)
}

fn clear_settings(connection: &Connection, scope: &str) -> Result<u64, DatabaseError> {
    let removed = connection.execute("DELETE FROM app_settings WHERE scope = ?1", [scope])?;
    u64::try_from(removed).map_err(|_| DatabaseError::InvalidSettingKey)
}

fn validate_setting_key(scope: &str, key: &str) -> Result<(), DatabaseError> {
    validate_setting_part(scope)?;
    validate_setting_part(key)?;
    if is_secret_setting_key(key) {
        return Err(DatabaseError::SecretSetting);
    }
    Ok(())
}

fn validate_setting_part(value: &str) -> Result<(), DatabaseError> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        Ok(())
    } else {
        Err(DatabaseError::InvalidSettingKey)
    }
}

#[must_use]
pub fn is_secret_setting_key(key: &str) -> bool {
    let normalized = canonicalize_setting_key(key);
    normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("passphrase")
        || normalized.contains("credential")
        || normalized.contains("client_secret")
        || normalized.contains("private_key")
        || normalized.contains("authorization")
        || matches!(
            normalized.as_str(),
            "access_key"
                | "access_tokens"
                | "auth"
                | "auth_tokens"
                | "bearer"
                | "client_id"
                | "cookie"
                | "cookies"
                | "gemini_blacklisted_keys"
                | "jwt"
                | "oauth_tokens"
                | "refresh_tokens"
                | "secret"
                | "secret_key"
                | "secrets"
                | "session_id"
                | "session_key"
                | "token"
        )
        || normalized.ends_with("_access_key")
        || normalized.ends_with("_access_tokens")
        || normalized.ends_with("_auth")
        || normalized.ends_with("_auth_tokens")
        || normalized.ends_with("_bearer")
        || normalized.ends_with("_client_id")
        || normalized.ends_with("_cookie")
        || normalized.ends_with("_cookies")
        || normalized.ends_with("_jwt")
        || normalized.ends_with("_oauth_tokens")
        || normalized.ends_with("_refresh_tokens")
        || normalized.ends_with("_session_id")
        || normalized.ends_with("_session_key")
        || normalized.ends_with("_secret")
        || normalized.ends_with("_secret_key")
        || normalized.ends_with("_secrets")
        || normalized.ends_with("_token")
        || normalized.ends_with("_access_token")
        || normalized.ends_with("_refresh_token")
        || normalized.ends_with("_auth_token")
}

fn canonicalize_setting_key(key: &str) -> String {
    let mut canonical = String::with_capacity(key.len());
    let mut characters = key.chars().peekable();
    let mut previous = None;

    while let Some(character) = characters.next() {
        if matches!(character, '.' | ':' | '-' | '_') {
            if !canonical.ends_with('_') {
                canonical.push('_');
            }
        } else {
            let split_before_uppercase = character.is_ascii_uppercase()
                && (previous.is_some_and(|previous: char| {
                    previous.is_ascii_lowercase() || previous.is_ascii_digit()
                }) || (previous.is_some_and(|previous: char| previous.is_ascii_uppercase())
                    && characters.peek().is_some_and(char::is_ascii_lowercase)));
            if split_before_uppercase && !canonical.ends_with('_') {
                canonical.push('_');
            }
            canonical.push(character.to_ascii_lowercase());
        }
        previous = Some(character);
    }

    canonical
}
