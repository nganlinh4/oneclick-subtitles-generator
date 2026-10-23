//! Download status, inspection, start and cancel commands.

use std::sync::Arc;

use osg_domain::{JobId, JobKind, JobSnapshot, JobUpdate};
use osg_download::{
    AudioQuality, CancellationToken, DownloadDestination, DownloadEngine, DownloadError,
    DownloadPlan, MediaSelection, RunControl, SubtitleSelection, VideoHeight, VideoQuality,
};
use osg_download::{BrowserCookieSource, DownloadCookies};
use tauri::{AppHandle, State, ipc::Channel};
use uuid::Uuid;

use super::errors::{
    download_error_diagnostic, map_download_error, record_download_admission_failure,
    record_download_inspection_failure,
};
use super::finish::{
    DownloadProgressReporter, DownloadTaskError, NativeDownloadOutput, finish_download,
};
use super::runtime::{DownloadRuntime, OutputDirectory};
use super::types::{
    AudioQualityRequest, DownloadInspectRequest, DownloadInspectionResponse, DownloadJobEvent,
    DownloadStartRequest, DownloadStatusResponse, DownloadUnavailableReason, MediaSelectionRequest,
    VideoQualityRequest,
};
#[cfg(feature = "e2e-automation")]
use std::path::Path;

#[cfg(feature = "e2e-automation")]
use super::types::CookieSourceRequest;
#[cfg(feature = "e2e-automation")]
use super::{
    AUTOMATION_BROWSER_PROFILE_ENV, AUTOMATION_COOKIE_FILE_ENV, AUTOMATION_FIXTURE_ROOT_ENV,
};
use super::{DOWNLOAD_TIMEOUT, INSPECTION_TIMEOUT, MAX_CONCURRENT_DOWNLOADS, STATUS_TIMEOUT};
use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;
#[cfg(feature = "e2e-automation")]
use osg_download::{AutomationBrowserProfile, AutomationCookieFile};

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn download_status(
    runtime: State<'_, DownloadRuntime>,
) -> CommandResult<DownloadStatusResponse> {
    let tools = runtime.tools()?;
    let Some(engine) = tools.engine else {
        return Ok(status_response(
            false,
            false,
            None,
            Some(DownloadUnavailableReason::DownloaderUnavailable),
        ));
    };
    if !tools.js_runtime_available {
        return Ok(status_response(
            false,
            false,
            None,
            Some(DownloadUnavailableReason::JavaScriptRuntimeUnavailable),
        ));
    }
    let js_engine = engine.clone();
    let js_runtime_health = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(STATUS_TIMEOUT)?;
        js_engine.javascript_runtime_version(&control)
    })
    .await
    .map_err(|_| {
        CommandError::internal("The JavaScript runtime health task stopped unexpectedly.")
    })?;
    if js_runtime_health.is_err() {
        return Ok(status_response(
            false,
            false,
            None,
            Some(DownloadUnavailableReason::JavaScriptRuntimeUnavailable),
        ));
    }
    let version = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(STATUS_TIMEOUT)?;
        engine.version(&control)
    })
    .await
    .map_err(|_| CommandError::internal("The downloader health task stopped unexpectedly."))?;
    let Ok(version) = version else {
        return Ok(status_response(
            false,
            false,
            None,
            Some(DownloadUnavailableReason::DownloaderHealthCheckFailed),
        ));
    };
    let inspect_available = true;
    let (available, reason) = if !tools.ffmpeg_available {
        (
            false,
            Some(DownloadUnavailableReason::MediaToolsUnavailable),
        )
    } else if runtime.cache_root.is_none() {
        (false, Some(DownloadUnavailableReason::CacheUnavailable))
    } else {
        (true, None)
    };
    diagnostics::record(
        "download.status_resolved",
        &[
            ("available", available.to_string()),
            ("inspectAvailable", "true".to_owned()),
            ("mediaTools", tools.ffmpeg_available.to_string()),
        ],
    );
    Ok(status_response(
        available,
        inspect_available,
        Some(version.as_str().to_owned()),
        reason,
    ))
}

pub(super) fn status_response(
    available: bool,
    inspect_available: bool,
    version: Option<String>,
    reason: Option<DownloadUnavailableReason>,
) -> DownloadStatusResponse {
    DownloadStatusResponse {
        available,
        inspect_available,
        version,
        reason,
        max_concurrent_downloads: MAX_CONCURRENT_DOWNLOADS,
        inventory_ttl_seconds: 15 * 60,
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn download_inspect(
    runtime: State<'_, DownloadRuntime>,
    request: DownloadInspectRequest,
) -> CommandResult<DownloadInspectionResponse> {
    diagnostics::record("download.inspection_requested", &[]);
    // Browser-cookie extraction reaches outside the isolated E2E profile and may read a customer's
    // live Chrome, Edge, or Firefox data. The automation build therefore fails before it resolves
    // the download engine or starts any worker. A future cookie-file fixture must be a separately
    // typed path staged beneath OSG_E2E_FIXTURE_ROOT; it must not weaken this boundary.
    #[cfg(feature = "e2e-automation")]
    let cookies = resolve_browser_cookie_source(request.cookie_source)?;
    #[cfg(not(feature = "e2e-automation"))]
    let cookies = DownloadCookies::from(BrowserCookieSource::from(request.cookie_source));
    let engine = runtime.engine().inspect_err(|error| {
        if let Ok(tools) = runtime.tools() {
            diagnostics::record(
                "download.inspection_runtime_unavailable",
                &[
                    ("downloader", tools.engine.is_some().to_string()),
                    ("javascriptRuntime", tools.js_runtime_available.to_string()),
                    ("mediaTools", tools.ffmpeg_available.to_string()),
                ],
            );
        }
        record_download_inspection_failure("runtime-unavailable", Some(error.code()));
    })?;
    let _permit = runtime.inspection_slots.acquire().ok_or_else(|| {
        record_download_inspection_failure("inspection-slots-full", Some("internal"));
        CommandError::internal("Too many media inspections are already running.")
    })?;
    let inspection_cookies = cookies.clone();
    let (url, inventory) = tauri::async_runtime::spawn_blocking(move || {
        let url = engine.validate_url(&request.url)?;
        let control = RunControl::new(INSPECTION_TIMEOUT)?;
        let inventory = engine.inspect(&url, inspection_cookies, &control)?;
        Ok::<_, DownloadError>((url, inventory))
    })
    .await
    .map_err(|_| {
        record_download_inspection_failure("task-stopped", Some("internal"));
        CommandError::internal("The media inspection task stopped unexpectedly.")
    })?
    .map_err(|error| {
        let mapped = map_download_error(&error);
        record_download_inspection_failure(download_error_diagnostic(&error), Some(mapped.code()));
        mapped
    })?;
    let capability = runtime
        .inventories
        .insert(url, inventory.clone(), cookies)
        .map_err(|error| {
            let mapped = map_download_error(&error);
            record_download_inspection_failure(
                download_error_diagnostic(&error),
                Some(mapped.code()),
            );
            mapped
        })?;
    diagnostics::record("download.inspection_completed", &[]);
    Ok(DownloadInspectionResponse {
        capability,
        inventory,
    })
}

#[cfg(feature = "e2e-automation")]
fn resolve_browser_cookie_source(request: CookieSourceRequest) -> CommandResult<DownloadCookies> {
    if request == CookieSourceRequest::None {
        return Ok(DownloadCookies::None);
    }
    let root = std::env::var_os(AUTOMATION_FIXTURE_ROOT_ENV).ok_or_else(|| {
        CommandError::invalid_input("The automation cookie fixture is unavailable.")
    })?;
    if let Some(path) = std::env::var_os(AUTOMATION_COOKIE_FILE_ENV) {
        return AutomationCookieFile::new(Path::new(&path), Path::new(&root))
            .map(DownloadCookies::AutomationFile)
            .map_err(|_| CommandError::invalid_input("The automation cookie fixture is invalid."));
    }
    let path = std::env::var_os(AUTOMATION_BROWSER_PROFILE_ENV).ok_or_else(|| {
        CommandError::invalid_input(
            "The automation build refused access to a live browser profile.",
        )
    })?;
    AutomationBrowserProfile::new(
        BrowserCookieSource::from(request),
        Path::new(&path),
        Path::new(&root),
    )
    .map(DownloadCookies::AutomationBrowserProfile)
    .map_err(|_| CommandError::invalid_input("The automation browser profile is invalid."))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle, State, and Channel as owned command extractors"
)]
pub(crate) async fn download_start(
    app: AppHandle,
    state: State<'_, DesktopState>,
    runtime: State<'_, DownloadRuntime>,
    request: DownloadStartRequest,
    on_event: Channel<DownloadJobEvent>,
) -> CommandResult<JobSnapshot> {
    let (engine, output_directory, plan) = prepare_download_start(&runtime, request)?;
    let Some(permit) = runtime.download_slots.acquire() else {
        record_download_admission_failure("download-slots-full", Some("internal"));
        return Err(CommandError::internal(
            "Too many media downloads are already running.",
        ));
    };
    let jobs = Arc::clone(&state.jobs);
    let ticket = match background::register_running(&jobs, JobKind::DownloadMedia).await {
        Ok(ticket) => ticket,
        Err(error) => {
            record_download_admission_failure("job-registration", Some(error.code()));
            return Err(error);
        }
    };
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    diagnostics::record("download.started", &[("job", job_id.to_string())]);
    let job_cancellation = ticket.cancellation().clone();
    let finalizing = Arc::clone(&runtime.finalizing);

    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        // Keep the authenticated staging journal and directory alive until download finalization
        // has either published the media or cleaned the failed attempt. Dropping this guard before
        // the task runs removes the directory out from under yt-dlp.
        let _output_directory = output_directory;
        let process_cancellation = CancellationToken::default();
        let cancellation_bridge = process_cancellation.clone();
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            cancellation_bridge.cancel();
        });
        let reporter = DownloadProgressReporter {
            jobs: Arc::clone(&jobs),
            job_id,
            channel: on_event.clone(),
        };
        let control = match RunControl::new(DOWNLOAD_TIMEOUT) {
            Ok(control) => control
                .with_cancellation(process_cancellation)
                .with_progress(reporter),
            Err(error) => {
                watcher.abort();
                finish_download(
                    &app,
                    &jobs,
                    job_id,
                    Err(DownloadTaskError::Download(error)),
                    &on_event,
                    &finalizing,
                )
                .await;
                return;
            }
        };
        let result = tauri::async_runtime::spawn_blocking(move || {
            engine
                .download(&plan, &control)
                .and_then(|result| NativeDownloadOutput::from_result(&result))
                .map_err(DownloadTaskError::Download)
        })
        .await
        .map_err(|_| {
            DownloadTaskError::Command(CommandError::internal(
                "The media download task stopped unexpectedly.",
            ))
        })
        .and_then(|result| result);
        watcher.abort();
        finish_download(&app, &jobs, job_id, result, &on_event, &finalizing).await;
    });

    Ok(initial)
}

fn prepare_download_start(
    runtime: &DownloadRuntime,
    request: DownloadStartRequest,
) -> CommandResult<(DownloadEngine, OutputDirectory, DownloadPlan)> {
    let (engine, cache_root) = match runtime.download_parts() {
        Ok(parts) => parts,
        Err(error) => {
            record_download_admission_failure("runtime-unavailable", Some(error.code()));
            return Err(error);
        }
    };
    let capability = match runtime.inventories.resolve(request.inventory_id) {
        Ok(capability) => capability,
        Err(error) => {
            let mapped = map_download_error(&error);
            record_download_admission_failure(
                download_error_diagnostic(&error),
                Some(mapped.code()),
            );
            return Err(mapped);
        }
    };
    let output_id = Uuid::now_v7();
    let (destination, output_directory) =
        match cache_root.destination(output_id, capability.inventory().title.as_str()) {
            Ok(destination) => destination,
            Err(error) => {
                let mapped = map_download_error(&error);
                record_download_admission_failure(
                    download_error_diagnostic(&error),
                    Some(mapped.code()),
                );
                return Err(mapped);
            }
        };
    let plan = match create_plan(&capability, destination, request) {
        Ok(plan) => plan,
        Err(error) => {
            let mapped = map_download_error(&error);
            record_download_admission_failure(
                download_error_diagnostic(&error),
                Some(mapped.code()),
            );
            return Err(mapped);
        }
    };
    Ok((engine, output_directory, plan))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn download_cancel(
    state: State<'_, DesktopState>,
    runtime: State<'_, DownloadRuntime>,
    job_id: JobId,
) -> CommandResult<JobSnapshot> {
    let jobs = Arc::clone(&state.jobs);
    let finalizing = Arc::clone(&runtime.finalizing);
    tauri::async_runtime::spawn_blocking(move || {
        finalizing.run_if_cancellable(job_id, || {
            let current = jobs.get(job_id)?;
            if current.snapshot().kind() != JobKind::DownloadMedia {
                return Err(CommandError::invalid_input(
                    "The job is not a media download.",
                ));
            }
            if current.snapshot().state().is_terminal() {
                return Ok(current.snapshot().clone());
            }
            jobs.apply(job_id, JobUpdate::RequestCancellation)
                .map(|ticket| ticket.snapshot().clone())
                .map_err(Into::into)
        })
    })
    .await
    .map_err(|_| CommandError::internal("The download cancellation task stopped unexpectedly."))?
}

fn create_plan(
    capability: &osg_download::InventoryCapability,
    destination: DownloadDestination,
    request: DownloadStartRequest,
) -> Result<DownloadPlan, DownloadError> {
    let inventory = capability.inventory();
    let media = match request.media {
        MediaSelectionRequest::Video { quality } => MediaSelection::Video {
            quality: match quality {
                VideoQualityRequest::Best => VideoQuality::Best,
                VideoQualityRequest::AtMost { height } => {
                    VideoQuality::AtMost(VideoHeight::new(height)?)
                }
                VideoQualityRequest::Exact { format_id } => {
                    VideoQuality::Exact(inventory.select_format(&format_id)?)
                }
            },
        },
        MediaSelectionRequest::Audio { quality, format } => MediaSelection::Audio {
            quality: match quality {
                AudioQualityRequest::Best => AudioQuality::Best,
                AudioQualityRequest::Exact { format_id } => {
                    AudioQuality::Exact(inventory.select_format(&format_id)?)
                }
            },
            format: format.into(),
        },
    };
    let subtitle = request
        .subtitle
        .map_or(Ok(SubtitleSelection::None), |selection| {
            inventory
                .select_subtitle(&selection.language, selection.source.into())
                .map(SubtitleSelection::Selected)
        })?;
    DownloadPlan::new(
        capability.url().clone(),
        inventory,
        destination,
        media,
        subtitle,
        capability.cookies().clone(),
    )
}
