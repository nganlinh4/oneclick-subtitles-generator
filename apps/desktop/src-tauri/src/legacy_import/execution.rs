//! Import execution: credentials, settings and verified artifact publication.

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use osg_infrastructure::secrets::{
    CredentialBackend, CredentialPurpose, CredentialService, CredentialState,
    CredentialStoreAvailability,
};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactKind, ArtifactRegistration, ArtifactState,
    ContentHash, Database, DatabaseError, LegacyImportItemOutcome, LegacyImportItemState,
    LegacyImportSourceKind, LegacyImportState,
};
use same_file::Handle;
use secrecy::ExposeSecret;
use serde_json::json;

use super::source_files::{is_reparse_point, open_source_file, verify_source_path};
use super::types::{
    ImportWork, LegacyImportPlan, PlannedArtifact, PlannedItem, PlanningError, SourceRoot,
    ValidatedSourceFile,
};
use super::{APP_SETTINGS_SCOPE, LegacyImportReport};
use crate::error::CommandResult;

pub(super) fn execute_import<B>(
    database: &Database,
    credentials: &CredentialService<B>,
    plan: LegacyImportPlan,
) -> CommandResult<LegacyImportReport>
where
    B: CredentialBackend,
{
    let LegacyImportPlan {
        source_root,
        fingerprint,
        items,
    } = plan;
    let candidates = items
        .iter()
        .map(|item| item.candidate.clone())
        .collect::<Vec<_>>();
    let prepared = database.prepare_legacy_import(
        LegacyImportSourceKind::ElectronRootV1,
        fingerprint,
        &candidates,
    )?;
    if prepared.state() == LegacyImportState::Complete {
        return Ok(LegacyImportReport {
            summary: prepared,
            source_retained: true,
            already_imported: true,
        });
    }

    let ExistingCredentials {
        purposes: mut configured_purposes,
        secrets: mut configured_secrets,
        complete: credential_resolution_complete,
    } = inspect_existing_credentials(credentials);

    let processing_result = (|| -> Result<(), DatabaseError> {
        for PlannedItem { candidate, work } in items {
            if matches!(
                database.legacy_import_item_state(prepared.source_id(), &candidate)?,
                Some(LegacyImportItemState::Imported | LegacyImportItemState::Skipped)
            ) {
                continue;
            }
            let outcome = match work {
                ImportWork::Setting { key, value } => {
                    if database.get_setting(APP_SETTINGS_SCOPE, &key)?.is_some() {
                        LegacyImportItemOutcome::skipped("existingNativeSetting")
                    } else if database
                        .put_setting(APP_SETTINGS_SCOPE, &key, &value)
                        .is_ok()
                    {
                        LegacyImportItemOutcome::imported(None)
                    } else {
                        LegacyImportItemOutcome::failed("settingImportFailed")
                    }
                }
                ImportWork::Credential {
                    purpose,
                    secret_fingerprint,
                    request,
                } => {
                    if !credential_resolution_complete {
                        LegacyImportItemOutcome::failed("credentialStoreUnavailable")
                    } else if configured_secrets.contains(&(purpose, secret_fingerprint))
                        || (!purpose.allows_multiple() && configured_purposes.contains(&purpose))
                    {
                        LegacyImportItemOutcome::skipped("existingNativeCredential")
                    } else {
                        match credentials.set(request) {
                            Ok(status) => {
                                configured_purposes.insert(purpose);
                                configured_secrets.insert((purpose, secret_fingerprint));
                                LegacyImportItemOutcome::imported(Some(status.id.as_uuid()))
                            }
                            Err(_) => LegacyImportItemOutcome::failed("credentialImportFailed"),
                        }
                    }
                }
                ImportWork::Artifact(artifact) => {
                    publish_artifact(database, &source_root, &artifact)?
                }
                ImportWork::Ignored(reason) => LegacyImportItemOutcome::skipped(reason),
            };
            database.record_legacy_import_item(prepared.source_id(), &candidate, &outcome)?;
        }
        Ok(())
    })();
    if let Err(error) = processing_result {
        let _ = database.finish_legacy_import(prepared.source_id());
        return Err(error.into());
    }
    let summary = database.finish_legacy_import(prepared.source_id())?;
    Ok(LegacyImportReport {
        summary,
        source_retained: true,
        already_imported: false,
    })
}

pub(super) struct ExistingCredentials {
    purposes: HashSet<CredentialPurpose>,
    pub(super) secrets: HashSet<(CredentialPurpose, ContentHash)>,
    complete: bool,
}

fn inspect_existing_credentials<B>(credentials: &CredentialService<B>) -> ExistingCredentials
where
    B: CredentialBackend,
{
    let mut existing = ExistingCredentials {
        purposes: HashSet::new(),
        secrets: HashSet::new(),
        complete: false,
    };
    let Ok(report) = credentials.status(None) else {
        return existing;
    };
    if report.store != CredentialStoreAvailability::Available {
        return existing;
    }
    existing.complete = true;
    for credential in report.credentials {
        match credential.state {
            CredentialState::Ready => {
                existing.purposes.insert(credential.purpose);
                match credentials.resolve(credential.id, credential.purpose) {
                    Ok(secret) => {
                        existing.secrets.insert((
                            credential.purpose,
                            ContentHash::digest(secret.expose_secret().as_bytes()),
                        ));
                    }
                    Err(_) => existing.complete = false,
                }
            }
            CredentialState::Unavailable => {
                if credentials.delete(credential.id).is_err() {
                    existing.complete = false;
                }
            }
            CredentialState::Pending => existing.complete = false,
        }
    }
    existing
}

pub(super) fn publish_artifact(
    database: &Database,
    source_root: &SourceRoot,
    artifact: &PlannedArtifact,
) -> Result<LegacyImportItemOutcome, DatabaseError> {
    let Ok(mut source) = open_planned_artifact(source_root, artifact) else {
        return Ok(LegacyImportItemOutcome::failed("legacySourceChanged"));
    };
    let metadata = json!({
        "source": "electronRootV1",
        "extension": artifact.extension,
    });
    let draft = ArtifactDraft::new(
        ArtifactKind::new(artifact.kind)?,
        artifact.content_hash,
        artifact.size_bytes,
        metadata,
    )?;
    let mut retried_failed_record = false;
    let artifact_id = loop {
        match database.register_artifact(&draft)? {
            ArtifactRegistration::Existing(record) => match record.state() {
                ArtifactState::Ready => {
                    if database.resolve_artifact(record.id())?.is_some() {
                        break record.id();
                    }
                    return Ok(LegacyImportItemOutcome::failed("legacyArtifactUnavailable"));
                }
                ArtifactState::Pending => unreachable!("pending records have an explicit variant"),
                ArtifactState::Failed if !retried_failed_record => {
                    let _ = database.remove_artifact(record.id())?;
                    retried_failed_record = true;
                }
                ArtifactState::Failed => {
                    return Ok(LegacyImportItemOutcome::failed("legacyArtifactUnavailable"));
                }
            },
            ArtifactRegistration::Staging(staging) => {
                let artifact_id = staging.record().id();
                let copied = copy_source_to_staging(&mut source, artifact, staging.path())
                    .and_then(|()| {
                        verify_source_path(
                            source_root,
                            &artifact.source_path,
                            &source.identity,
                            false,
                        )
                        .map_err(|_| std::io::Error::other("legacy source changed"))
                    });
                if copied.is_err() || database.mark_artifact_ready(artifact_id).is_err() {
                    fail_artifact_publication(database, artifact_id);
                    return Ok(LegacyImportItemOutcome::failed("legacyArtifactChanged"));
                }
                break artifact_id;
            }
            ArtifactRegistration::Pending(record) => {
                return Err(DatabaseError::ArtifactPublicationInProgress(record.id()));
            }
        }
    };
    Ok(LegacyImportItemOutcome::imported(Some(
        *artifact_id.as_uuid(),
    )))
}

fn open_planned_artifact(
    source_root: &SourceRoot,
    artifact: &PlannedArtifact,
) -> Result<ValidatedSourceFile, PlanningError> {
    let mut source = open_source_file(source_root, &artifact.source_path)?;
    if source.metadata.len() != artifact.size_bytes {
        return Err(PlanningError::Invalid);
    }
    let content_hash = digest_exact(&mut source.file, artifact.size_bytes)?;
    if content_hash != artifact.content_hash {
        return Err(PlanningError::Invalid);
    }
    source.file.seek(SeekFrom::Start(0))?;
    verify_source_path(source_root, &artifact.source_path, &source.identity, false)?;
    Ok(source)
}

fn fail_artifact_publication(
    database: &Database,
    artifact_id: osg_infrastructure::storage::ArtifactId,
) {
    if let Ok(code) = ArtifactFailureCode::new("legacyImport") {
        let _ = database.mark_artifact_failed(artifact_id, &code);
    }
}

fn copy_source_to_staging(
    source: &mut ValidatedSourceFile,
    artifact: &PlannedArtifact,
    destination: &Path,
) -> std::io::Result<()> {
    let metadata = source.file.metadata()?;
    if !metadata.is_file()
        || is_reparse_point(&metadata)
        || metadata.len() != artifact.size_bytes
        || Handle::from_file(source.file.try_clone()?)? != source.identity
    {
        return Err(std::io::Error::other("legacy source changed"));
    }
    source.file.seek(SeekFrom::Start(0))?;
    let mut target = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(destination)?;
    let copied = std::io::copy(
        &mut (&mut source.file).take(artifact.size_bytes.saturating_add(1)),
        &mut target,
    )?;
    if copied != artifact.size_bytes {
        return Err(std::io::Error::other("legacy source changed"));
    }
    target.flush()?;
    target.sync_all()
}

pub(super) fn digest_exact(
    file: &mut File,
    expected_size: u64,
) -> Result<ContentHash, PlanningError> {
    file.seek(SeekFrom::Start(0))?;
    let limit = expected_size
        .checked_add(1)
        .ok_or(PlanningError::TooLarge)?;
    let mut bounded = (&mut *file).take(limit);
    let hash = ContentHash::digest_reader(&mut bounded)?;
    let bytes_read = limit.saturating_sub(bounded.limit());
    if bytes_read != expected_size {
        return Err(PlanningError::Invalid);
    }
    Ok(hash)
}
