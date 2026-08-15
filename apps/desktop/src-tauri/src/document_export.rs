use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

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
            Self::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            Self::Jpeg => bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]),
            Self::Webp => {
                bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
            }
            Self::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            Self::Wav => {
                bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE"
            }
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
    let selected = app
        .dialog()
        .file()
        .set_title("Export subtitles")
        .set_file_name(&request.suggested_name)
        .add_filter(request.format.label(), &[request.format.extension()])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let destination = selected
        .into_path()
        .map_err(|_| CommandError::media_export_unsafe())?;
    if !has_expected_extension(&destination, request.format) {
        return Err(CommandError::invalid_input(
            "The subtitle export file type is invalid.",
        ));
    }

    tauri::async_runtime::spawn_blocking(move || write_document(&request.content, &destination))
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
    let selected = app
        .dialog()
        .file()
        .set_title("Export subtitle archive")
        .set_file_name(&request.suggested_name)
        .add_filter("ZIP subtitle archive", &["zip"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let destination = selected
        .into_path()
        .map_err(|_| CommandError::media_export_unsafe())?;
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("zip"))
    {
        return Err(CommandError::invalid_input(
            "The subtitle archive file type is invalid.",
        ));
    }

    tauri::async_runtime::spawn_blocking(move || write_archive(&request.entries, &destination))
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
        .ok_or_else(invalid_generated_file)?;
    let suggested_name = request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| is_safe_generated_name(value, format))
        .ok_or_else(invalid_generated_file)?
        .to_owned();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid_generated_file());
    };
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES || !format.has_valid_signature(bytes) {
        return Err(invalid_generated_file());
    }
    let bytes = bytes.clone();

    let _operation_lease = acquire_export_operation()?;
    let selected = app
        .dialog()
        .file()
        .set_title("Export generated file")
        .set_file_name(suggested_name)
        .add_filter(format.label(), &[format.extension()])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let destination = selected
        .into_path()
        .map_err(|_| CommandError::media_export_unsafe())?;
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case(format.extension()))
    {
        return Err(CommandError::invalid_input(
            "The generated file type is invalid.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || write_bytes(&bytes, &destination))
        .await
        .map_err(|_| {
            CommandError::internal("The generated-file export task stopped unexpectedly.")
        })??;
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

fn write_archive(entries: &[SubtitleArchiveEntry], destination: &Path) -> CommandResult<()> {
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
    copy_export(source.path(), destination, length, || false, |_, _| Ok(()))
        .map_err(|_| CommandError::subtitle_export_failed())
}

fn write_document(content: &str, destination: &Path) -> CommandResult<()> {
    write_bytes(content.as_bytes(), destination)
}

fn write_bytes(bytes: &[u8], destination: &Path) -> CommandResult<()> {
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
        source.path(),
        destination,
        u64::try_from(bytes.len()).map_err(|_| CommandError::subtitle_export_failed())?,
        || false,
        |_, _| Ok(()),
    )
    .map_err(|_| CommandError::subtitle_export_failed())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn request(
        name: &str,
        format: SubtitleDocumentFormat,
        content: &str,
    ) -> SubtitleDocumentExportRequest {
        SubtitleDocumentExportRequest {
            suggested_name: name.to_owned(),
            format,
            content: content.to_owned(),
        }
    }

    #[test]
    fn validates_unicode_names_and_exact_document_types() {
        assert!(
            validate_request(&request("phụ đề.srt", SubtitleDocumentFormat::Srt, "1\n")).is_ok()
        );
        assert!(
            validate_request(&request(
                "captions.JSON",
                SubtitleDocumentFormat::Json,
                "[]"
            ))
            .is_ok()
        );
        assert!(validate_request(&request("notes.txt", SubtitleDocumentFormat::Txt, "")).is_ok());
        assert!(
            validate_request(&request(
                "../captions.srt",
                SubtitleDocumentFormat::Srt,
                "1"
            ))
            .is_err()
        );
        assert!(
            validate_request(&request("captions.txt", SubtitleDocumentFormat::Srt, "1")).is_err()
        );
        assert!(
            validate_request(&request("captions .srt", SubtitleDocumentFormat::Srt, "1")).is_err()
        );
    }

    #[test]
    fn writes_utf8_with_atomic_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("captions.srt");
        fs::write(&destination, b"old").unwrap();

        write_document(
            "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n",
            &destination,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(destination).unwrap(),
            "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn accepts_only_flat_bounded_structured_subtitle_archives() {
        let request = SubtitleArchiveExportRequest {
            suggested_name: "translated_subtitles.zip".to_owned(),
            entries: vec![
                SubtitleArchiveEntry {
                    suggested_name: "captions.srt".to_owned(),
                    format: SubtitleDocumentFormat::Srt,
                    content: "1\n00:00:00,000 --> 00:00:01,000\nHello".to_owned(),
                },
                SubtitleArchiveEntry {
                    suggested_name: "translated.json".to_owned(),
                    format: SubtitleDocumentFormat::Json,
                    content: "[]".to_owned(),
                },
            ],
        };
        assert!(validate_archive_request(&request).is_ok());

        let duplicate = SubtitleArchiveExportRequest {
            suggested_name: "translated_subtitles.zip".to_owned(),
            entries: vec![
                SubtitleArchiveEntry {
                    suggested_name: "captions.srt".to_owned(),
                    format: SubtitleDocumentFormat::Srt,
                    content: "first".to_owned(),
                },
                SubtitleArchiveEntry {
                    suggested_name: "CAPTIONS.SRT".to_owned(),
                    format: SubtitleDocumentFormat::Srt,
                    content: "second".to_owned(),
                },
            ],
        };
        assert!(validate_archive_request(&duplicate).is_err());
        let oversized = SubtitleArchiveExportRequest {
            suggested_name: "translated_subtitles.zip".to_owned(),
            entries: vec![SubtitleArchiveEntry {
                suggested_name: "captions.srt".to_owned(),
                format: SubtitleDocumentFormat::Srt,
                content: "x".repeat(MAX_DOCUMENT_BYTES + 1),
            }],
        };
        assert!(validate_archive_request(&oversized).is_err());
        assert!(is_safe_archive_name("translated_subtitles.zip"));
        assert!(!is_safe_archive_name("../translated.zip"));
    }

    #[test]
    fn creates_a_native_zip_from_validated_entries() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("captions.zip");
        let entries = vec![SubtitleArchiveEntry {
            suggested_name: "captions.srt".to_owned(),
            format: SubtitleDocumentFormat::Srt,
            content: "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요".to_owned(),
        }];
        write_archive(&entries, &destination).unwrap();
        let file = fs::File::open(destination).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut content = String::new();
        std::io::Read::read_to_string(&mut archive.by_index(0).unwrap(), &mut content).unwrap();
        assert_eq!(content, entries[0].content);
    }

    #[test]
    fn allows_only_one_document_export_dialog_at_a_time() {
        let first = acquire_export_operation().unwrap();
        assert!(acquire_export_operation().is_err());
        drop(first);
        assert!(acquire_export_operation().is_ok());
    }

    #[test]
    fn validates_generated_file_signatures_and_names() {
        let png = b"\x89PNG\r\n\x1a\ncontent";
        assert!(GeneratedFileFormat::Png.has_valid_signature(png));
        assert!(is_safe_generated_name(
            "background-1.png",
            GeneratedFileFormat::Png
        ));
        assert!(!is_safe_generated_name(
            "../background.png",
            GeneratedFileFormat::Png
        ));
        assert!(!GeneratedFileFormat::Png.has_valid_signature(b"not an image"));

        let mut wav = b"RIFF\0\0\0\0WAVE".to_vec();
        wav.extend_from_slice(b"data");
        assert!(GeneratedFileFormat::Wav.has_valid_signature(&wav));
        assert!(!GeneratedFileFormat::Webm.has_valid_signature(&wav));
    }
}
