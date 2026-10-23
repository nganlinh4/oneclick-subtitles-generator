//! Image descriptors, format validation, export planning and error mapping.

use std::fmt;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::Path;

use osg_domain::ProjectId;
use osg_infrastructure::storage::{
    ArtifactId, ArtifactKind, ArtifactRecord, ArtifactState, ContentHash, Database,
};
use uuid::Uuid;

use super::commands::resolve_owned_image;
use super::types::{GeneratedImageDescriptor, GeneratedImageExportRequest};
use super::{
    ARTIFACT_KIND_PREFIX, COMMIT_ON_JOB_SUCCESS_METADATA_KEY, MAX_EXPORT_NAME_BYTES,
    MAX_GENERATED_IMAGE_BYTES,
};
use crate::error::{CommandError, CommandResult};

pub(super) fn artifact_kind(project_id: ProjectId) -> CommandResult<ArtifactKind> {
    let compact = project_id.to_string().replace('-', "");
    ArtifactKind::new(format!("{ARTIFACT_KIND_PREFIX}{compact}"))
        .map_err(|_| generated_image_storage_error())
}

pub(super) fn descriptor_from_record(
    record: &ArtifactRecord,
    expected_project_id: ProjectId,
) -> CommandResult<GeneratedImageDescriptor> {
    descriptor_from_record_in_state(record, expected_project_id, ArtifactState::Ready)
}

pub(super) fn descriptor_from_prepared_record(
    record: &ArtifactRecord,
    expected_project_id: ProjectId,
) -> CommandResult<GeneratedImageDescriptor> {
    descriptor_from_record_in_state(record, expected_project_id, ArtifactState::Pending)
}

fn descriptor_from_record_in_state(
    record: &ArtifactRecord,
    expected_project_id: ProjectId,
    expected_state: ArtifactState,
) -> CommandResult<GeneratedImageDescriptor> {
    if record.project_id() != Some(expected_project_id)
        || record.kind() != &artifact_kind(expected_project_id)?
        || record.state() != expected_state
        || record.size_bytes() == 0
        || record.size_bytes() > MAX_GENERATED_IMAGE_BYTES as u64
    {
        return Err(generated_image_ownership_error());
    }
    let metadata = record
        .metadata()
        .as_object()
        .ok_or_else(generated_image_storage_error)?;
    let commit_on_job_success = metadata
        .get(COMMIT_ON_JOB_SUCCESS_METADATA_KEY)
        .and_then(serde_json::Value::as_bool);
    let metadata_is_valid = match expected_state {
        ArtifactState::Pending => {
            metadata.len() == 2 && commit_on_job_success == Some(true) && record.job_id().is_some()
        }
        ArtifactState::Ready => {
            (metadata.len() == 1 && commit_on_job_success.is_none())
                || (metadata.len() == 2
                    && commit_on_job_success == Some(true)
                    && record.job_id().is_some())
        }
        ArtifactState::Failed => false,
    };
    if !metadata_is_valid {
        return Err(generated_image_storage_error());
    }
    let mime_type = metadata
        .get("mimeType")
        .and_then(serde_json::Value::as_str)
        .and_then(canonical_image_mime)
        .ok_or_else(generated_image_storage_error)?;
    Ok(GeneratedImageDescriptor {
        artifact_id: record.id(),
        project_id: expected_project_id,
        mime_type,
        size_bytes: record.size_bytes(),
        created_at_ms: record.created_at_ms(),
    })
}

pub(super) fn validate_generated_image(mime_type: &str, bytes: &[u8]) -> CommandResult<()> {
    if bytes.is_empty()
        || bytes.len() > MAX_GENERATED_IMAGE_BYTES
        || canonical_image_mime(mime_type).is_none()
        || !matches_image_signature(mime_type, bytes)
    {
        return Err(CommandError::invalid_input(
            "The generated image is empty, unsupported, or malformed.",
        ));
    }
    Ok(())
}

fn canonical_image_mime(value: &str) -> Option<&'static str> {
    match value {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

fn matches_image_signature(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum GeneratedImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl GeneratedImageFormat {
    fn from_mime_type(value: &str) -> Option<Self> {
        match value {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    pub(super) const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG image",
            Self::Jpeg => "JPEG image",
            Self::Webp => "WebP image",
        }
    }
}

pub(super) struct GeneratedImageExportPlan {
    pub(super) staging: tempfile::NamedTempFile,
    pub(super) suggested_name: String,
    pub(super) format: GeneratedImageFormat,
    pub(super) size_bytes: u64,
}

impl fmt::Debug for GeneratedImageExportPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImageExportPlan")
            .field("staging", &"<redacted>")
            .field("suggested_name", &"<redacted>")
            .field("format", &self.format)
            .field("size_bytes", &self.size_bytes)
            .finish()
    }
}

pub(super) fn prepare_image_export(
    database: &Database,
    request: GeneratedImageExportRequest,
) -> CommandResult<GeneratedImageExportPlan> {
    let artifact_id = parse_artifact_id(&request.artifact_id)?;
    let resolved = resolve_owned_image(database, request.project_id, artifact_id)?
        .ok_or_else(generated_image_unavailable)?;
    let descriptor = descriptor_from_record(resolved.record(), request.project_id)?;
    let format = GeneratedImageFormat::from_mime_type(descriptor.mime_type)
        .ok_or_else(generated_image_storage_error)?;
    if !is_safe_export_name(&request.suggested_name, format.extension()) {
        return Err(CommandError::invalid_input(
            "The generated-image export name is invalid.",
        ));
    }
    let directory = resolved
        .path()
        .parent()
        .ok_or_else(generated_image_export_error)?;
    let mut staging = tempfile::Builder::new()
        .prefix(".osg-image-export-")
        .suffix(".part")
        .tempfile_in(directory)
        .map_err(|_| generated_image_export_error())?;
    copy_verified_image(
        resolved.path(),
        staging.as_file_mut(),
        descriptor.size_bytes,
        resolved.record().content_hash(),
    )?;
    staging
        .as_file()
        .sync_all()
        .map_err(|_| generated_image_export_error())?;
    Ok(GeneratedImageExportPlan {
        staging,
        suggested_name: request.suggested_name,
        format,
        size_bytes: descriptor.size_bytes,
    })
}

fn copy_verified_image(
    source_path: &Path,
    output: &mut impl Write,
    expected_bytes: u64,
    expected_hash: ContentHash,
) -> CommandResult<()> {
    let mut source = fs::File::open(source_path)
        .map(BufReader::new)
        .map_err(|_| generated_image_export_error())?;
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    let mut hasher = blake3::Hasher::new();
    let mut copied = 0_u64;
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|_| generated_image_export_error())?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(count).map_err(|_| generated_image_export_error())?)
            .filter(|bytes| *bytes <= expected_bytes)
            .ok_or_else(generated_image_export_error)?;
        hasher.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|_| generated_image_export_error())?;
    }
    if copied != expected_bytes || hasher.finalize().as_bytes() != expected_hash.as_bytes() {
        return Err(generated_image_export_error());
    }
    Ok(())
}

pub(super) fn is_safe_export_name(value: &str, expected_extension: &str) -> bool {
    if value.is_empty() || value.len() > MAX_EXPORT_NAME_BYTES || !value.is_ascii() {
        return false;
    }
    value.rsplit_once('.').is_some_and(|(stem, extension)| {
        !stem.is_empty()
            && !stem.ends_with('.')
            && extension.eq_ignore_ascii_case(expected_extension)
            && stem
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    })
}

pub(super) fn reference_unavailable() -> CommandError {
    CommandError::invalid_input("The reference image is no longer available.")
}

pub(super) fn parse_artifact_id(value: &str) -> CommandResult<ArtifactId> {
    let uuid = Uuid::parse_str(value).map_err(|_| {
        CommandError::invalid_input("The generated-image artifact identifier is invalid.")
    })?;
    ArtifactId::from_uuid(uuid).map_err(|_| {
        CommandError::invalid_input("The generated-image artifact identifier is invalid.")
    })
}

pub(super) fn generated_image_unavailable() -> CommandError {
    CommandError::invalid_input("The generated image is unavailable.")
}

pub(super) fn generated_image_ownership_error() -> CommandError {
    CommandError::invalid_input("The generated image does not belong to this project.")
}

pub(super) fn generated_image_storage_error() -> CommandError {
    CommandError::internal("The generated image could not be stored durably.")
}

pub(super) fn generated_image_project_full() -> CommandError {
    CommandError::invalid_input(
        "This project already contains the maximum number of generated images.",
    )
}

pub(super) fn generated_image_in_progress() -> CommandError {
    CommandError::invalid_input("An identical generated image is still awaiting acknowledgement.")
}

pub(super) fn generated_image_export_error() -> CommandError {
    CommandError::internal("The generated image could not be exported.")
}
