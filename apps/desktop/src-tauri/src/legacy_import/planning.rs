//! Legacy root planning: bounded localStorage parsing and known-directory scans.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;

use osg_infrastructure::secrets::{CredentialPurpose, CredentialSetRequest};
use osg_infrastructure::storage::{
    ContentHash, LegacyImportItemKind, MAX_LEGACY_IMPORT_ITEMS, is_secret_setting_key,
};
use same_file::Handle;
use serde_json::{Value, json};

use super::classification::{
    artifact_kind, contains_location_bearing_value, is_importable_extension, is_native_setting_key,
    is_project_scoped_setting_key, is_transient_setting_key, string_value,
};
use super::execution::digest_exact;
use super::source_files::{
    append_manifest_field, candidate, open_source_file, reject_unsafe_metadata, safe_relative_path,
    verify_source_path,
};
use super::types::{
    ImportWork, LegacyImportPlan, PlannedArtifact, PlannedItem, PlanningError, ScannedArtifact,
    ScannedFile, SensitiveBytes, SourceRoot, ValidatedSourceFile,
};
use super::{
    CREDENTIAL_SETTING_KEYS, LEGACY_ROOTS, MAX_LEGACY_GEMINI_KEYS, MAX_LEGACY_SETTING_JSON_BYTES,
    MAX_LOCAL_STORAGE_BYTES, MAX_LOCAL_STORAGE_KEYS, MAX_SOURCE_DIRECTORIES, MAX_SOURCE_ENTRIES,
    MAX_SOURCE_FILE_BYTES, MAX_SOURCE_FILES, MAX_SOURCE_TOTAL_BYTES,
};

pub(super) fn plan_legacy_root(selected_root: &Path) -> Result<LegacyImportPlan, PlanningError> {
    let source_root = SourceRoot::open(selected_root)?;

    let (local_storage_fingerprint, local_storage) = read_local_storage(&source_root)?;
    let mut items = plan_storage_items(local_storage)?;
    let remaining_items = MAX_LEGACY_IMPORT_ITEMS
        .checked_sub(items.len())
        .ok_or(PlanningError::TooLarge)?;
    let scanned_files = scan_known_roots(&source_root, remaining_items.min(MAX_SOURCE_FILES))?;
    if local_storage_fingerprint.is_none() && scanned_files.is_empty() {
        return Err(PlanningError::Invalid);
    }

    let mut manifest =
        Vec::with_capacity(scanned_files.len().saturating_mul(64).saturating_add(128));
    append_manifest_field(&mut manifest, b"osg-electron-root-v1")?;
    if let Some(fingerprint) = local_storage_fingerprint {
        append_manifest_field(&mut manifest, b"local-storage-present")?;
        append_manifest_field(&mut manifest, fingerprint.as_bytes())?;
    } else {
        append_manifest_field(&mut manifest, b"local-storage-absent")?;
    }

    let artifact_offset = items.len();
    for (index, scanned) in scanned_files.into_iter().enumerate() {
        append_manifest_field(&mut manifest, scanned.relative_path.as_bytes())?;
        append_manifest_field(&mut manifest, &scanned.size_bytes.to_be_bytes())?;
        let candidate = candidate(
            if scanned.import.is_some() {
                LegacyImportItemKind::Artifact
            } else {
                LegacyImportItemKind::Ignored
            },
            artifact_offset + index,
        )?;
        let work = if let Some(artifact) = scanned.import {
            append_manifest_field(&mut manifest, artifact.content_hash.as_bytes())?;
            ImportWork::Artifact(PlannedArtifact {
                source_path: scanned.source_path,
                kind: artifact.kind,
                extension: artifact.extension,
                content_hash: artifact.content_hash,
                size_bytes: scanned.size_bytes,
            })
        } else {
            append_manifest_field(&mut manifest, b"ignored-extension")?;
            ImportWork::Ignored("unsupportedLegacyFile")
        };
        items.push(PlannedItem { candidate, work });
    }

    Ok(LegacyImportPlan {
        source_root,
        fingerprint: ContentHash::digest(&manifest),
        items,
    })
}

fn read_local_storage(
    source_root: &SourceRoot,
) -> Result<(Option<ContentHash>, BTreeMap<String, Value>), PlanningError> {
    let path = source_root.canonical.join("localStorage.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((None, BTreeMap::new()));
        }
        Err(error) => return Err(error.into()),
    };
    reject_unsafe_metadata(&metadata, false)?;
    if metadata.len() > MAX_LOCAL_STORAGE_BYTES {
        return Err(PlanningError::TooLarge);
    }
    let ValidatedSourceFile {
        mut file,
        identity,
        metadata: opened_metadata,
    } = open_source_file(source_root, &path)?;
    if opened_metadata.len() > MAX_LOCAL_STORAGE_BYTES {
        return Err(PlanningError::TooLarge);
    }
    let mut bytes = SensitiveBytes(Vec::with_capacity(
        usize::try_from(opened_metadata.len()).unwrap_or(0),
    ));
    (&mut file)
        .take(MAX_LOCAL_STORAGE_BYTES + 1)
        .read_to_end(&mut bytes.0)?;
    if u64::try_from(bytes.0.len()).map_or(true, |length| length > MAX_LOCAL_STORAGE_BYTES) {
        return Err(PlanningError::TooLarge);
    }
    if u64::try_from(bytes.0.len()).ok() != Some(opened_metadata.len()) {
        return Err(PlanningError::Invalid);
    }
    let fingerprint = ContentHash::digest(&bytes.0);
    if digest_exact(&mut file, opened_metadata.len())? != fingerprint {
        return Err(PlanningError::Invalid);
    }
    verify_source_path(source_root, &path, &identity, false)?;
    let values = serde_json::from_slice::<BTreeMap<String, Value>>(&bytes.0)?;
    if values.len() > MAX_LOCAL_STORAGE_KEYS {
        return Err(PlanningError::TooLarge);
    }
    Ok((Some(fingerprint), values))
}

#[allow(clippy::too_many_lines)]
pub(super) fn plan_storage_items(
    values: BTreeMap<String, Value>,
) -> Result<Vec<PlannedItem>, PlanningError> {
    let mut items = Vec::new();
    let mut seen_secrets = HashSet::new();
    let mut credential_index = 0_usize;

    let mut add_credential =
        |purpose: CredentialPurpose, secret: String| -> Result<(), PlanningError> {
            let secret = secret.trim().to_owned();
            if secret.is_empty() || secret.len() > 16 * 1024 {
                return Ok(());
            }
            let secret_fingerprint = ContentHash::digest(secret.as_bytes());
            if seen_secrets.contains(&(purpose, secret_fingerprint)) {
                return Ok(());
            }
            if purpose == CredentialPurpose::GeminiApiKey
                && seen_secrets
                    .iter()
                    .filter(|(candidate, _)| *candidate == CredentialPurpose::GeminiApiKey)
                    .count()
                    >= MAX_LEGACY_GEMINI_KEYS
            {
                return Ok(());
            }
            seen_secrets.insert((purpose, secret_fingerprint));
            items.push(PlannedItem {
                candidate: candidate(LegacyImportItemKind::Credential, credential_index)?,
                work: ImportWork::Credential {
                    purpose,
                    secret_fingerprint,
                    request: CredentialSetRequest::new(purpose, secret),
                },
            });
            credential_index += 1;
            Ok(())
        };

    if let Some(value) = string_value(&values, "gemini_api_keys")
        && let Ok(keys) = serde_json::from_str::<Vec<String>>(value)
    {
        for key in keys.into_iter().take(MAX_LEGACY_GEMINI_KEYS) {
            add_credential(CredentialPurpose::GeminiApiKey, key)?;
        }
    }
    for key in ["gemini_api_key", "gemini_token"] {
        if let Some(value) = string_value(&values, key) {
            add_credential(CredentialPurpose::GeminiApiKey, value.to_owned())?;
        }
    }
    if let Some(value) = string_value(&values, "genius_token") {
        add_credential(CredentialPurpose::GeniusAccessToken, value.to_owned())?;
    }
    if let Some(value) = string_value(&values, "youtube_api_key") {
        add_credential(CredentialPurpose::YouTubeApiKey, value.to_owned())?;
    }
    if let (Some(client_id), Some(client_secret)) = (
        string_value(&values, "youtube_client_id"),
        string_value(&values, "youtube_client_secret"),
    ) && !client_id.trim().is_empty()
        && !client_secret.trim().is_empty()
    {
        let pair = serde_json::to_string(&json!({
            "clientId": client_id.trim(),
            "clientSecret": client_secret.trim(),
        }))?;
        add_credential(CredentialPurpose::YouTubeOauthClient, pair)?;
    }
    for (index, (key, value)) in values.into_iter().enumerate() {
        let kind;
        let work;
        if CREDENTIAL_SETTING_KEYS.contains(&key.as_str()) || is_secret_setting_key(&key) {
            kind = LegacyImportItemKind::Ignored;
            work = ImportWork::Ignored(if key == "youtube_oauth_token" {
                "unsupportedOauthToken"
            } else {
                "credentialMovedToVault"
            });
        } else if is_project_scoped_setting_key(&key) || is_transient_setting_key(&key) {
            kind = LegacyImportItemKind::Ignored;
            work = ImportWork::Ignored("transientLegacyValue");
        } else if !is_native_setting_key(&key)
            || !value.is_string()
            || contains_location_bearing_value(&value)
            || serde_json::to_vec(&value)?.len() > MAX_LEGACY_SETTING_JSON_BYTES
        {
            kind = LegacyImportItemKind::Ignored;
            work = ImportWork::Ignored("invalidLegacySetting");
        } else {
            kind = LegacyImportItemKind::Setting;
            work = ImportWork::Setting { key, value };
        }
        items.push(PlannedItem {
            candidate: candidate(kind, credential_index + index)?,
            work,
        });
    }
    Ok(items)
}

fn scan_known_roots(
    source_root: &SourceRoot,
    max_files: usize,
) -> Result<Vec<ScannedFile>, PlanningError> {
    let mut files = Vec::new();
    let mut directory_count = 0_usize;
    let mut total_bytes = 0_u64;
    for relative_root in LEGACY_ROOTS {
        let directory = source_root.canonical.join(relative_root);
        let directory_metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        reject_unsafe_metadata(&directory_metadata, true)?;
        let mut pending = vec![directory];
        while let Some(current) = pending.pop() {
            directory_count = directory_count.saturating_add(1);
            if directory_count > MAX_SOURCE_DIRECTORIES {
                return Err(PlanningError::TooLarge);
            }
            source_root.verify()?;
            let current_metadata = fs::symlink_metadata(&current)?;
            reject_unsafe_metadata(&current_metadata, true)?;
            let current_identity = Handle::from_path(&current)?;
            let canonical = fs::canonicalize(&current)?;
            if !canonical.starts_with(&source_root.canonical) {
                return Err(PlanningError::Invalid);
            }
            let mut entries = Vec::new();
            for entry in fs::read_dir(&current)? {
                entries.push(entry?);
                if entries.len() > MAX_SOURCE_ENTRIES {
                    return Err(PlanningError::TooLarge);
                }
            }
            verify_source_path(source_root, &current, &current_identity, true)?;
            entries.sort_by_key(std::fs::DirEntry::file_name);
            for entry in entries {
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path)?;
                if metadata.is_dir() {
                    reject_unsafe_metadata(&metadata, true)?;
                    pending.push(path);
                    continue;
                }
                reject_unsafe_metadata(&metadata, false)?;
                if files.len() >= max_files {
                    return Err(PlanningError::TooLarge);
                }
                let ValidatedSourceFile {
                    file,
                    identity: opened_identity,
                    metadata: opened_metadata,
                } = open_source_file(source_root, &path)?;
                if opened_metadata.len() > MAX_SOURCE_FILE_BYTES {
                    return Err(PlanningError::TooLarge);
                }
                total_bytes = total_bytes
                    .checked_add(opened_metadata.len())
                    .filter(|total| *total <= MAX_SOURCE_TOTAL_BYTES)
                    .ok_or(PlanningError::TooLarge)?;
                let relative_path = safe_relative_path(&source_root.canonical, &path)?;
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .unwrap_or_default();
                let import = if is_importable_extension(&extension) {
                    let mut file = file;
                    let content_hash = digest_exact(&mut file, opened_metadata.len())?;
                    verify_source_path(source_root, &path, &opened_identity, false)?;
                    Some(ScannedArtifact {
                        kind: artifact_kind(&relative_path),
                        extension,
                        content_hash,
                    })
                } else {
                    None
                };
                files.push(ScannedFile {
                    source_path: path,
                    relative_path,
                    size_bytes: opened_metadata.len(),
                    import,
                });
            }
        }
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}
