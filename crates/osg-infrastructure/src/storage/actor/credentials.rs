//! Credential status rows: actor requests, the `Database` API, and the credential table. Secret
//! values never pass through here; only purpose, state, and a validated last-four hint.

use std::sync::mpsc::SyncSender;

use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use super::{Database, Request, now_ms};
use crate::secrets::{CredentialId, CredentialPurpose, CredentialState, CredentialStatus};
use crate::storage::error::DatabaseError;

pub(super) enum CredentialRequest {
    InsertPending {
        id: CredentialId,
        purpose: CredentialPurpose,
        reply: SyncSender<Result<CredentialStatus, DatabaseError>>,
    },
    MarkReady {
        id: CredentialId,
        last4: String,
        reply: SyncSender<Result<CredentialStatus, DatabaseError>>,
    },
    MarkUnavailable {
        id: CredentialId,
        reply: SyncSender<Result<CredentialStatus, DatabaseError>>,
    },
    List {
        purpose: Option<CredentialPurpose>,
        reply: SyncSender<Result<Vec<CredentialStatus>, DatabaseError>>,
    },
    Get {
        id: CredentialId,
        reply: SyncSender<Result<CredentialStatus, DatabaseError>>,
    },
    Delete {
        id: CredentialId,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
}

impl std::fmt::Debug for CredentialRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InsertPending { .. } => "CredentialInsertPending",
            Self::MarkReady { .. } => "CredentialMarkReady",
            Self::MarkUnavailable { .. } => "CredentialMarkUnavailable",
            Self::List { .. } => "CredentialList",
            Self::Get { .. } => "CredentialGet",
            Self::Delete { .. } => "CredentialDelete",
        })
    }
}

impl From<CredentialRequest> for Request {
    fn from(request: CredentialRequest) -> Self {
        Self::Credentials(request)
    }
}

impl CredentialRequest {
    pub(super) fn handle(self, connection: &mut Connection) {
        match self {
            Self::InsertPending { id, purpose, reply } => {
                let _ = reply.send(credential_insert_pending(connection, id, purpose));
            }
            Self::MarkReady { id, last4, reply } => {
                let _ = reply.send(credential_mark_ready(connection, id, &last4));
            }
            Self::MarkUnavailable { id, reply } => {
                let _ = reply.send(credential_mark_unavailable(connection, id));
            }
            Self::List { purpose, reply } => {
                let _ = reply.send(credential_list(connection, purpose));
            }
            Self::Get { id, reply } => {
                let _ = reply.send(credential_get(connection, id));
            }
            Self::Delete { id, reply } => {
                let _ = reply.send(credential_delete(connection, id));
            }
        }
    }
}

impl Database {
    pub fn credential_insert_pending(
        &self,
        id: CredentialId,
        purpose: CredentialPurpose,
    ) -> Result<CredentialStatus, DatabaseError> {
        self.request(|reply| CredentialRequest::InsertPending { id, purpose, reply })
    }

    pub fn credential_mark_ready(
        &self,
        id: CredentialId,
        last4: &str,
    ) -> Result<CredentialStatus, DatabaseError> {
        validate_last4(last4)?;
        self.request(|reply| CredentialRequest::MarkReady {
            id,
            last4: last4.to_owned(),
            reply,
        })
    }

    pub fn credential_mark_unavailable(
        &self,
        id: CredentialId,
    ) -> Result<CredentialStatus, DatabaseError> {
        self.request(|reply| CredentialRequest::MarkUnavailable { id, reply })
    }

    pub fn credential_list(
        &self,
        purpose: Option<CredentialPurpose>,
    ) -> Result<Vec<CredentialStatus>, DatabaseError> {
        self.request(|reply| CredentialRequest::List { purpose, reply })
    }

    pub fn credential_get(&self, id: CredentialId) -> Result<CredentialStatus, DatabaseError> {
        self.request(|reply| CredentialRequest::Get { id, reply })
    }

    pub fn credential_delete(&self, id: CredentialId) -> Result<bool, DatabaseError> {
        self.request(|reply| CredentialRequest::Delete { id, reply })
    }
}

fn credential_insert_pending(
    connection: &Connection,
    id: CredentialId,
    purpose: CredentialPurpose,
) -> Result<CredentialStatus, DatabaseError> {
    if !purpose.allows_multiple()
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM credential_refs WHERE purpose = ?1)",
            [purpose.as_str()],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Err(DatabaseError::CredentialPurposeAlreadyExists(purpose));
    }
    let timestamp = now_ms();
    connection.execute(
        "INSERT INTO credential_refs(
           id, purpose, status, last_four, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, 'pending', NULL, ?3, ?3)",
        params![id.as_uuid(), purpose.as_str(), timestamp],
    )?;
    Ok(CredentialStatus::pending(id, purpose))
}

fn credential_mark_ready(
    connection: &Connection,
    id: CredentialId,
    last4: &str,
) -> Result<CredentialStatus, DatabaseError> {
    validate_last4(last4)?;
    let changed = connection.execute(
        "UPDATE credential_refs
         SET status = 'ready', last_four = ?1, updated_at_ms = ?2
         WHERE id = ?3",
        params![last4, now_ms(), id.as_uuid()],
    )?;
    if changed == 0 {
        return Err(DatabaseError::CredentialNotFound);
    }
    credential_get(connection, id)
}

fn credential_mark_unavailable(
    connection: &Connection,
    id: CredentialId,
) -> Result<CredentialStatus, DatabaseError> {
    let changed = connection.execute(
        "UPDATE credential_refs
         SET status = 'unavailable', updated_at_ms = ?1
         WHERE id = ?2",
        params![now_ms(), id.as_uuid()],
    )?;
    if changed == 0 {
        return Err(DatabaseError::CredentialNotFound);
    }
    credential_get(connection, id)
}

fn credential_get(
    connection: &Connection,
    id: CredentialId,
) -> Result<CredentialStatus, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT id, purpose, status, last_four
             FROM credential_refs WHERE id = ?1",
            [id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, Uuid>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or(DatabaseError::CredentialNotFound)?;
    credential_status_from_row(row)
}

fn credential_list(
    connection: &Connection,
    purpose: Option<CredentialPurpose>,
) -> Result<Vec<CredentialStatus>, DatabaseError> {
    let mut statement = connection.prepare(
        "SELECT id, purpose, status, last_four
         FROM credential_refs
         WHERE ?1 IS NULL OR purpose = ?1
         ORDER BY created_at_ms, id",
    )?;
    let purpose = purpose.map(CredentialPurpose::as_str);
    let rows = statement.query_map([purpose], |row| {
        Ok((
            row.get::<_, Uuid>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut credentials = Vec::new();
    for row in rows {
        credentials.push(credential_status_from_row(row?)?);
    }
    Ok(credentials)
}

fn credential_status_from_row(
    (id, purpose, state, last4): (Uuid, String, String, Option<String>),
) -> Result<CredentialStatus, DatabaseError> {
    let purpose = purpose
        .parse()
        .map_err(|_| DatabaseError::InvalidCredentialMetadata)?;
    let state = state
        .parse()
        .map_err(|_| DatabaseError::InvalidCredentialMetadata)?;
    if let Some(value) = &last4 {
        validate_last4(value).map_err(|_| DatabaseError::InvalidCredentialMetadata)?;
    }
    if state == CredentialState::Ready && last4.is_none() {
        return Err(DatabaseError::InvalidCredentialMetadata);
    }
    Ok(CredentialStatus::from_parts(
        CredentialId::from_uuid(id).map_err(|_| DatabaseError::InvalidCredentialMetadata)?,
        purpose,
        state,
        last4,
    ))
}

fn credential_delete(connection: &Connection, id: CredentialId) -> Result<bool, DatabaseError> {
    let changed =
        connection.execute("DELETE FROM credential_refs WHERE id = ?1", [id.as_uuid()])?;
    Ok(changed != 0)
}

fn validate_last4(value: &str) -> Result<(), DatabaseError> {
    if (1..=4).contains(&value.chars().count()) {
        Ok(())
    } else {
        Err(DatabaseError::InvalidCredentialMetadata)
    }
}
