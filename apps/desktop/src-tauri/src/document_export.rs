use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use osg_formats::image::ImageKind;
use osg_formats::wav;
use osg_runtime_staging::RuntimeStagingAuthority;
use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

use crate::diagnostics;
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::media_export::copy_export;

const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_FILE_NAME_BYTES: usize = 240;
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 256;
const CONTENT_TYPE_HEADER: &str = "x-osg-content-type";
const FILE_NAME_HEADER: &str = "x-osg-file-name";
static EXPORT_OPERATION_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ExportOperationLease;

impl Drop for ExportOperationLease {
    fn drop(&mut self) {
        EXPORT_OPERATION_ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SubtitleDocumentFormat {
    Srt,
    Json,
    Txt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeneratedFileFormat {
    Png,
    Jpeg,
    Webp,
    Gif,
    Wav,
    Webm,
}

impl GeneratedFileFormat {
    fn from_content_type(value: &str) -> Option<Self> {
        match value {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/webp" => Some(Self::Webp),
            "image/gif" => Some(Self::Gif),
            "audio/wav" | "audio/wave" | "audio/x-wav" => Some(Self::Wav),
            "audio/webm" => Some(Self::Webm),
            _ => None,
        }
    }

    const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Gif => "gif",
            Self::Wav => "wav",
            Self::Webm => "webm",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG image",
            Self::Jpeg => "JPEG image",
            Self::Webp => "WebP image",
            Self::Gif => "GIF image",
            Self::Wav => "WAV audio",
            Self::Webm => "WebM audio",
        }
    }

    fn has_valid_signature(self, bytes: &[u8]) -> bool {
        match self {
            Self::Png => ImageKind::Png.matches(bytes),
            // A whole file is exported, so its end-of-image marker must be present too.
            Self::Jpeg => ImageKind::Jpeg.matches(bytes) && bytes.ends_with(&[0xff, 0xd9]),
            Self::Webp => ImageKind::Webp.matches(bytes),
            Self::Gif => ImageKind::Gif.matches(bytes),
            Self::Wav => wav::has_signature(bytes),
            Self::Webm => {
                bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
                    && bytes
                        .get(..bytes.len().min(4096))
                        .is_some_and(|prefix| prefix.windows(4).any(|window| window == b"webm"))
            }
        }
    }
}

impl SubtitleDocumentFormat {
    const fn extension(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Json => "json",
            Self::Txt => "txt",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Srt => "SubRip subtitles",
            Self::Json => "JSON subtitles",
            Self::Txt => "Plain text subtitles",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubtitleDocumentExportRequest {
    suggested_name: String,
    format: SubtitleDocumentFormat,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubtitleArchiveEntry {
    suggested_name: String,
    format: SubtitleDocumentFormat,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubtitleArchiveExportRequest {
    suggested_name: String,
    entries: Vec<SubtitleArchiveEntry>,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and the request as owned command extractors"
)]
pub(crate) async fn subtitle_document_export(
    app: AppHandle,
    request: SubtitleDocumentExportRequest,
) -> CommandResult<bool> {
    validate_request(&request)?;
    let _operation_lease = acquire_export_operation()?;
    let selected = dialog_paths::save_file(
        &app,
        "Export subtitles",
        &request.suggested_name,
        request.format.label(),
        &[request.format.extension()],
    )?;
    let Some(destination) = selected else {
        return Ok(false);
    };
    if !has_expected_extension(&destination, request.format) {
        return Err(CommandError::invalid_input(
            "The subtitle export file type is invalid.",
        ));
    }

    let staging_authority = app.state::<RuntimeStagingAuthority>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_document(&staging_authority, &request.content, &destination)
    })
    .await
    .map_err(|_| CommandError::internal("The subtitle export task stopped unexpectedly."))??;
    Ok(true)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and Request as owned command extractors"
)]
pub(crate) async fn subtitle_archive_export(
    app: AppHandle,
    request: SubtitleArchiveExportRequest,
) -> CommandResult<bool> {
    validate_archive_request(&request)?;

    let _operation_lease = acquire_export_operation()?;
    let selected = dialog_paths::save_file(
        &app,
        "Export subtitle archive",
        &request.suggested_name,
        "ZIP subtitle archive",
        &["zip"],
    )?;
    let Some(destination) = selected else {
        return Ok(false);
    };
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("zip"))
    {
        return Err(CommandError::invalid_input(
            "The subtitle archive file type is invalid.",
        ));
    }

    let staging_authority = app.state::<RuntimeStagingAuthority>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_archive(&staging_authority, &request.entries, &destination)
    })
    .await
    .map_err(|_| CommandError::internal("The subtitle archive task stopped unexpectedly."))??;
    Ok(true)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and Request as owned command extractors"
)]
pub(crate) async fn generated_file_export(
    app: AppHandle,
    request: Request<'_>,
) -> CommandResult<bool> {
    let format = request
        .headers()
        .get(CONTENT_TYPE_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(GeneratedFileFormat::from_content_type)
        .ok_or_else(|| refused_generated_file("contentType"))?;
    let suggested_name = request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| is_safe_generated_name(value, format))
        .ok_or_else(|| refused_generated_file("fileName"))?
        .to_owned();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(refused_generated_file("body"));
    };
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES || !format.has_valid_signature(bytes) {
        return Err(refused_generated_file("signature"));
    }
    diagnostics::record(
        "generated-file.export_started",
        &[
            ("format", format.extension().to_owned()),
            ("bytes", bytes.len().to_string()),
        ],
    );
    let bytes = bytes.clone();

    let _operation_lease = acquire_export_operation()?;
    let selected = dialog_paths::save_file(
        &app,
        "Export generated file",
        &suggested_name,
        format.label(),
        &[format.extension()],
    )?;
    let Some(destination) = selected else {
        return Ok(false);
    };
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case(format.extension()))
    {
        return Err(CommandError::invalid_input(
            "The generated file type is invalid.",
        ));
    }
    let staging_authority = app.state::<RuntimeStagingAuthority>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_bytes(&staging_authority, &bytes, &destination)
    })
    .await
    .map_err(|_| {
        CommandError::internal("The generated-file export task stopped unexpectedly.")
    })??;
    diagnostics::record(
        "generated-file.export_completed",
        &[("format", format.extension().to_owned())],
    );
    Ok(true)
}

fn validate_request(request: &SubtitleDocumentExportRequest) -> CommandResult<()> {
    if request.content.len() > MAX_DOCUMENT_BYTES
        || !is_safe_suggested_name(&request.suggested_name, request.format)
    {
        return Err(CommandError::invalid_input(
            "The subtitle export request is invalid.",
        ));
    }
    Ok(())
}

fn is_safe_suggested_name(value: &str, format: SubtitleDocumentFormat) -> bool {
    if value.is_empty()
        || value.len() > MAX_FILE_NAME_BYTES
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
                )
        })
    {
        return false;
    }
    let Some((stem, extension)) = value.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && !stem.ends_with([' ', '.'])
        && extension.eq_ignore_ascii_case(format.extension())
}

fn has_expected_extension(path: &Path, format: SubtitleDocumentFormat) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(format.extension()))
}

fn is_safe_archive_name(value: &str) -> bool {
    value.len() >= 5
        && value.len() <= MAX_FILE_NAME_BYTES
        && value.is_ascii()
        && value.strip_suffix(".zip").is_some_and(|stem| {
            !stem.is_empty()
                && stem
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
                && !stem.ends_with('.')
        })
}

fn is_safe_generated_name(value: &str, format: GeneratedFileFormat) -> bool {
    value.len() > format.extension().len() + 1
        && value.len() <= MAX_FILE_NAME_BYTES
        && value.is_ascii()
        && value.rsplit_once('.').is_some_and(|(stem, extension)| {
            !stem.is_empty()
                && !stem.ends_with('.')
                && extension.eq_ignore_ascii_case(format.extension())
                && stem
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
}

fn invalid_generated_file() -> CommandError {
    CommandError::invalid_input("The generated file is invalid.")
}

fn refused_generated_file(stage: &'static str) -> CommandError {
    diagnostics::record(
        "generated-file.export_refused",
        &[("stage", stage.to_owned())],
    );
    invalid_generated_file()
}

fn invalid_archive() -> CommandError {
    CommandError::invalid_input("The subtitle archive is invalid.")
}

fn acquire_export_operation() -> CommandResult<ExportOperationLease> {
    EXPORT_OPERATION_ACTIVE
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map(|_| ExportOperationLease)
        .map_err(|_| {
            CommandError::invalid_input("Another file export operation is already running.")
        })
}

fn validate_archive_request(request: &SubtitleArchiveExportRequest) -> CommandResult<()> {
    if !is_safe_archive_name(&request.suggested_name)
        || request.entries.is_empty()
        || request.entries.len() > MAX_ARCHIVE_ENTRIES
    {
        return Err(invalid_archive());
    }
    let mut names = BTreeSet::new();
    let mut expanded_bytes = 0_usize;
    for entry in &request.entries {
        if matches!(entry.format, SubtitleDocumentFormat::Txt)
            || !is_safe_suggested_name(&entry.suggested_name, entry.format)
            || !names.insert(entry.suggested_name.to_lowercase())
            || entry.content.len() > MAX_DOCUMENT_BYTES
        {
            return Err(invalid_archive());
        }
        expanded_bytes = expanded_bytes
            .checked_add(entry.content.len())
            .filter(|size| *size <= MAX_ARCHIVE_BYTES)
            .ok_or_else(invalid_archive)?;
    }
    Ok(())
}

fn write_archive(
    staging_authority: &RuntimeStagingAuthority,
    entries: &[SubtitleArchiveEntry],
    destination: &Path,
) -> CommandResult<()> {
    let mut source = tempfile::Builder::new()
        .prefix(".osg-subtitle-archive-")
        .suffix(".part")
        .tempfile()
        .map_err(|_| CommandError::subtitle_export_failed())?;
    {
        let mut archive = zip::ZipWriter::new(source.as_file_mut());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for entry in entries {
            archive
                .start_file(&entry.suggested_name, options)
                .map_err(|_| CommandError::subtitle_export_failed())?;
            archive
                .write_all(entry.content.as_bytes())
                .map_err(|_| CommandError::subtitle_export_failed())?;
        }
        archive
            .finish()
            .map_err(|_| CommandError::subtitle_export_failed())?;
    }
    source
        .as_file()
        .sync_all()
        .map_err(|_| CommandError::subtitle_export_failed())?;
    let length = source
        .as_file()
        .metadata()
        .map_err(|_| CommandError::subtitle_export_failed())?
        .len();
    copy_export(
        staging_authority,
        source.path(),
        destination,
        length,
        || false,
        |_, _| Ok(()),
    )
    .map_err(|_| CommandError::subtitle_export_failed())
}

fn write_document(
    staging_authority: &RuntimeStagingAuthority,
    content: &str,
    destination: &Path,
) -> CommandResult<()> {
    write_bytes(staging_authority, content.as_bytes(), destination)
}

fn write_bytes(
    staging_authority: &RuntimeStagingAuthority,
    bytes: &[u8],
    destination: &Path,
) -> CommandResult<()> {
    let mut source = tempfile::Builder::new()
        .prefix(".osg-subtitle-export-")
        .suffix(".part")
        .tempfile()
        .map_err(|_| CommandError::subtitle_export_failed())?;
    source
        .as_file_mut()
        .write_all(bytes)
        .map_err(|_| CommandError::subtitle_export_failed())?;
    source
        .as_file()
        .sync_all()
        .map_err(|_| CommandError::subtitle_export_failed())?;
    copy_export(
        staging_authority,
        source.path(),
        destination,
        u64::try_from(bytes.len()).map_err(|_| CommandError::subtitle_export_failed())?,
        || false,
        |_, _| Ok(()),
    )
    .map_err(|_| CommandError::subtitle_export_failed())
}

#[cfg(test)]
mod tests;
