//! Reference-image export planning, verified writes and error mapping.

use std::fmt;
use std::io::Write;
use std::path::Path;

use osg_gemini::MAX_REFERENCE_IMAGE_BYTES;
use osg_media_server::{MediaServer, RegisteredImageCopy};
use osg_runtime_staging::RuntimeStagingAuthority;

use super::MAX_EXPORT_NAME_BYTES;
use super::requests::ImageReferenceExportRequest;
use crate::error::{CommandError, CommandResult};
use crate::media_export::{ExportCopyError, copy_export};

#[derive(Debug, Clone, Copy)]
pub(super) enum ReferenceImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ReferenceImageFormat {
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

pub(super) struct ReferenceImageExportPlan {
    pub(super) image: RegisteredImageCopy,
    pub(super) suggested_name: String,
    pub(super) format: ReferenceImageFormat,
}

impl fmt::Debug for ReferenceImageExportPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReferenceImageExportPlan")
            .field("image", &self.image)
            .field("suggested_name", &"<redacted>")
            .field("format", &self.format)
            .finish()
    }
}

pub(super) fn prepare_reference_image_export(
    media_server: &MediaServer,
    request: &ImageReferenceExportRequest,
) -> CommandResult<ReferenceImageExportPlan> {
    let image = media_server
        .copy_registered_image_for_owner(
            request.playback_id,
            request.project_id.into_uuid(),
            MAX_REFERENCE_IMAGE_BYTES,
        )?
        .ok_or_else(invalid_image_blob)?;
    let format =
        ReferenceImageFormat::from_mime_type(image.mime_type()).ok_or_else(invalid_image_blob)?;
    let suggested_name =
        canonical_export_name(&request.suggested_name, format).ok_or_else(invalid_image_blob)?;
    Ok(ReferenceImageExportPlan {
        image,
        suggested_name,
        format,
    })
}

pub(super) fn canonical_export_name(value: &str, format: ReferenceImageFormat) -> Option<String> {
    if value.len() < 5 || value.len() > MAX_EXPORT_NAME_BYTES || !value.is_ascii() {
        return None;
    }
    let (stem, extension) = value.rsplit_once('.')?;
    if stem.is_empty()
        || stem.ends_with('.')
        || !matches!(
            extension.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "webp"
        )
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return None;
    }
    Some(format!("{stem}.{}", format.extension()))
}

pub(super) fn write_reference_image_export(
    staging_authority: &RuntimeStagingAuthority,
    bytes: &[u8],
    destination: &Path,
) -> CommandResult<()> {
    let mut staged = tempfile::Builder::new()
        .prefix(".osg-album-art-export-")
        .suffix(".part")
        .tempfile()
        .map_err(|_| CommandError::media_export_failed())?;
    staged
        .as_file_mut()
        .write_all(bytes)
        .map_err(|_| CommandError::media_export_failed())?;
    staged
        .as_file()
        .sync_all()
        .map_err(|_| CommandError::media_export_failed())?;
    copy_export(
        staging_authority,
        staged.path(),
        destination,
        u64::try_from(bytes.len()).map_err(|_| CommandError::media_export_failed())?,
        || false,
        |_, _| Ok(()),
    )
    .map_err(reference_export_error)
}

fn reference_export_error(error: ExportCopyError) -> CommandError {
    match error {
        ExportCopyError::UnsafeDestination => CommandError::media_export_unsafe(),
        ExportCopyError::SourceChanged => CommandError::media_export_source_changed(),
        ExportCopyError::Cancelled
        | ExportCopyError::ChannelClosed
        | ExportCopyError::JobUpdate
        | ExportCopyError::Io => CommandError::media_export_failed(),
    }
}

pub(super) fn invalid_image_blob() -> CommandError {
    CommandError::invalid_input("The reference image is empty, unsupported, or malformed.")
}

pub(super) fn reference_project_unavailable() -> CommandError {
    CommandError::invalid_input("The reference-image project is unavailable.")
}

pub(super) fn image_capacity_reached() -> CommandError {
    CommandError::internal("The temporary reference-image limit has been reached.")
}

pub(super) fn image_storage_unavailable() -> CommandError {
    CommandError::internal("Temporary reference-image storage is unavailable.")
}
