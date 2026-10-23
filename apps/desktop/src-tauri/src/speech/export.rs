//! Speech artifact export to a user-chosen file or archive.

use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use osg_infrastructure::storage::{ContentHash, Database};
use osg_runtime_staging::{OwnedStagingFile, RuntimeStagingAuthority, StagingKind};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use zip::write::SimpleFileOptions;

use super::artifact_types::{SpeechArtifactExportRequest, SpeechPlayableArtifact};
use super::artifacts::{
    descriptor_from_record, ensure_speech_artifact_kind, parse_artifact_id,
    register_speech_playback,
};
use super::runtime::SpeechRuntime;
use super::{
    MAX_CONVERSION_INPUT_BYTES, MAX_EXPORT_ARCHIVE_BYTES, MAX_EXPORT_FILE_NAME_BYTES, MAX_SEGMENTS,
};
use crate::dialog_paths;
use crate::error::{CommandError, CommandResult};
use crate::media_export::copy_export;
use crate::state::DesktopState;

pub(super) struct SpeechExportSource {
    pub(super) path: PathBuf,
    pub(super) content_hash: ContentHash,
    pub(super) expected_bytes: u64,
    pub(super) file_name: String,
}

pub(super) struct SpeechExportPlan {
    pub(super) sources: Vec<SpeechExportSource>,
    pub(super) archive_name: Option<String>,
}

impl SpeechExportPlan {
    fn selected_file_name(&self) -> &str {
        self.archive_name
            .as_deref()
            .unwrap_or(&self.sources[0].file_name)
    }

    fn selected_extension(&self) -> &str {
        self.archive_name.as_ref().map_or_else(
            || {
                self.sources[0]
                    .file_name
                    .rsplit_once('.')
                    .map_or("wav", |(_, ext)| ext)
            },
            |_| "zip",
        )
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and State as owned command extractors"
)]
pub(crate) async fn speech_artifact_export(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: SpeechArtifactExportRequest,
) -> CommandResult<bool> {
    let database = state.database.clone();
    let plan =
        tauri::async_runtime::spawn_blocking(move || prepare_speech_export(&database, request))
            .await
            .map_err(|_| {
                CommandError::internal("The narration export lookup stopped unexpectedly.")
            })??;

    let selected = dialog_paths::save_file(
        &app,
        "Export narration audio",
        plan.selected_file_name(),
        "Narration audio",
        &[plan.selected_extension()],
    )?;
    let Some(destination) = selected else {
        return Ok(false);
    };

    let staging_authority = app
        .state::<SpeechRuntime>()
        .inner()
        .0
        .staging_authority
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_speech_plan(&staging_authority, &plan, &destination)
    })
    .await
    .map_err(|_| CommandError::internal("The narration export task stopped unexpectedly."))??;
    Ok(true)
}

pub(super) fn prepare_speech_export(
    database: &Database,
    request: SpeechArtifactExportRequest,
) -> CommandResult<SpeechExportPlan> {
    if request.entries.is_empty() || request.entries.len() > MAX_SEGMENTS {
        return Err(CommandError::invalid_input(
            "The narration export request is invalid.",
        ));
    }
    if request.entries.len() > 1 && request.archive_name.is_none() {
        return Err(CommandError::invalid_input(
            "Multiple narration files require an archive.",
        ));
    }
    if let Some(archive_name) = request.archive_name.as_deref()
        && !is_safe_export_file_name(archive_name, "zip")
    {
        return Err(CommandError::invalid_input(
            "The narration archive name is invalid.",
        ));
    }

    let mut file_names = HashSet::with_capacity(request.entries.len());
    let mut total_bytes = 0_u64;
    let mut sources = Vec::with_capacity(request.entries.len());
    for entry in request.entries {
        let id = parse_artifact_id(&entry.artifact_id)?;
        let resolved = database
            .resolve_artifact(id)?
            .ok_or_else(|| CommandError::invalid_input("The speech artifact is unavailable."))?;
        ensure_speech_artifact_kind(resolved.record().kind().as_str(), false)?;
        let descriptor = descriptor_from_record(resolved.record())?;
        if !is_safe_export_file_name(&entry.file_name, descriptor.format.extension())
            || !file_names.insert(entry.file_name.clone())
        {
            return Err(CommandError::invalid_input(
                "The narration export file name is invalid.",
            ));
        }
        total_bytes = total_bytes
            .checked_add(descriptor.bytes)
            .filter(|bytes| *bytes <= MAX_CONVERSION_INPUT_BYTES)
            .ok_or_else(|| {
                CommandError::invalid_input("The narration export exceeds the safe size limit.")
            })?;
        sources.push(SpeechExportSource {
            path: resolved.path().to_owned(),
            content_hash: resolved.record().content_hash(),
            expected_bytes: descriptor.bytes,
            file_name: entry.file_name,
        });
    }
    Ok(SpeechExportPlan {
        sources,
        archive_name: request.archive_name,
    })
}

pub(super) fn is_safe_export_file_name(value: &str, expected_extension: &str) -> bool {
    if value.is_empty() || value.len() > MAX_EXPORT_FILE_NAME_BYTES || !value.is_ascii() {
        return false;
    }
    let Some((stem, extension)) = value.rsplit_once('.') else {
        return false;
    };
    if extension != expected_extension || stem.is_empty() || stem.len() > 120 {
        return false;
    }
    let mut characters = stem.bytes();
    characters
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && characters.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(super) fn export_speech_plan(
    staging_authority: &RuntimeStagingAuthority,
    plan: &SpeechExportPlan,
    destination: &Path,
) -> CommandResult<()> {
    if plan.archive_name.is_none() {
        let source = plan
            .sources
            .first()
            .ok_or_else(CommandError::speech_export_failed)?;
        let mut staging = speech_export_staging(staging_authority, source)?;
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        write_verified_speech_source(
            source,
            staging
                .file_mut()
                .map_err(|_| CommandError::speech_export_failed())?,
            &mut buffer,
        )?;
        staging
            .sync_all()
            .map_err(|_| CommandError::speech_export_failed())?;
        return copy_export(
            staging_authority,
            staging.path(),
            destination,
            source.expected_bytes,
            || false,
            |_, _| Ok(()),
        )
        .map_err(|_| CommandError::speech_export_failed());
    }

    let source = plan
        .sources
        .first()
        .ok_or_else(CommandError::speech_export_failed)?;
    let mut staging = speech_export_staging(staging_authority, source)?;
    write_speech_archive(plan, &mut staging)?;
    let archive_bytes = fs::metadata(staging.path())
        .map_err(|_| CommandError::speech_export_failed())?
        .len();
    if archive_bytes == 0 || archive_bytes > MAX_EXPORT_ARCHIVE_BYTES {
        return Err(CommandError::speech_export_failed());
    }
    copy_export(
        staging_authority,
        staging.path(),
        destination,
        archive_bytes,
        || false,
        |_, _| Ok(()),
    )
    .map_err(|_| CommandError::speech_export_failed())
}

fn speech_export_staging(
    authority: &RuntimeStagingAuthority,
    source: &SpeechExportSource,
) -> CommandResult<OwnedStagingFile> {
    let directory = source
        .path
        .parent()
        .ok_or_else(CommandError::speech_export_failed)?;
    OwnedStagingFile::begin(authority, directory, StagingKind::MediaExport)
        .map_err(|_| CommandError::speech_export_failed())
}

fn write_speech_archive(
    plan: &SpeechExportPlan,
    staging: &mut OwnedStagingFile,
) -> CommandResult<()> {
    let output = staging
        .file_mut()
        .map_err(|_| CommandError::speech_export_failed())?;
    let mut archive = zip::ZipWriter::new(output);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    for source in &plan.sources {
        archive
            .start_file(&source.file_name, options)
            .map_err(|_| CommandError::speech_export_failed())?;
        write_verified_speech_source(source, &mut archive, &mut buffer)?;
    }
    archive
        .finish()
        .map_err(|_| CommandError::speech_export_failed())?
        .sync_all()
        .map_err(|_| CommandError::speech_export_failed())
}

fn write_verified_speech_source(
    source: &SpeechExportSource,
    output: &mut impl Write,
    buffer: &mut [u8],
) -> CommandResult<()> {
    let mut input = fs::File::open(&source.path)
        .map(BufReader::new)
        .map_err(|_| CommandError::speech_export_failed())?;
    let mut hasher = blake3::Hasher::new();
    let mut copied = 0_u64;
    loop {
        let count = input
            .read(buffer)
            .map_err(|_| CommandError::speech_export_failed())?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(count).map_err(|_| CommandError::speech_export_failed())?)
            .filter(|bytes| *bytes <= source.expected_bytes)
            .ok_or_else(CommandError::speech_export_failed)?;
        hasher.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|_| CommandError::speech_export_failed())?;
    }
    if copied != source.expected_bytes
        || hasher.finalize().as_bytes() != source.content_hash.as_bytes()
    {
        return Err(CommandError::speech_export_failed());
    }
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_artifact_resolve(
    state: State<'_, DesktopState>,
    artifact_id: String,
) -> CommandResult<SpeechPlayableArtifact> {
    let id = parse_artifact_id(&artifact_id)?;
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = database
            .resolve_artifact(id)?
            .ok_or_else(|| CommandError::invalid_input("The speech artifact is unavailable."))?;
        ensure_speech_artifact_kind(resolved.record().kind().as_str(), false)?;
        let artifact = descriptor_from_record(resolved.record())?;
        let playback = register_speech_playback(&media_server, resolved.path(), artifact.format)?;
        Ok(SpeechPlayableArtifact { artifact, playback })
    })
    .await
    .map_err(|_| CommandError::internal("The speech artifact task stopped unexpectedly."))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn speech_playback_release(
    state: State<'_, DesktopState>,
    playback_id: Uuid,
) -> CommandResult<bool> {
    state
        .media_server
        .unregister(playback_id)
        .map_err(Into::into)
}
