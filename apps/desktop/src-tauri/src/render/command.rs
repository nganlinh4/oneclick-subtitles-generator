//! The four commands the `WebView` calls, and the order their failures have to happen in.
//!
//! `render_start` is the one that changed engines. What it guarantees did not: one render at a
//! time, everything decidable refused before a job exists, a durable job with a manifest, a bounded
//! monotonic progress stream, prompt cancellation, no half-written output, and a typed path-free
//! refusal on every branch. What it does now is convert, decode, compose, encode and mux through
//! `osg-export` — the same pipeline the preview composites with — instead of staging frames for a
//! headless browser.
//!
//! # The one thing the `WebView` must now send
//!
//! An export draws text, and the architecture forbids a Rust text stack, so the glyphs have to
//! arrive already shaped. They arrive as `text`: an **optional** argument, so the payload the
//! current frontend sends still deserializes, and a request without it is refused with
//! [`refusal::text_not_staged`] rather than rendered with an atlas nobody chose. Guessing — picking
//! the most recently staged atlas, or re-deriving layout here — is the silent divergence between
//! preview and export that this pipeline exists to remove, so it is not done.

use std::sync::Arc;
use std::time::Instant;

use osg_domain::{JobId, JobKind, JobSnapshot};
use osg_render::{REMOTION_VERSION, RenderRequest};
use tauri::{State, ipc::Channel};
use uuid::Uuid;

use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};
use crate::glyph_atlas::registry::GlyphAtlasStore;
use crate::state::DesktopState;

use super::events::{
    RenderCompletedResult, RenderEvent, RenderPhaseResponse, RenderResultResponse,
    RenderRuntimeStatusResponse,
};
use super::export::{self, ExportControl, RENDER_TIMEOUT};
use super::host::{MAX_CONCURRENT_RENDERS, RenderRuntimeHost};
use super::manifest;
use super::prepare;
use super::progress::ExportProgressSink;
use super::publish::{self, Publication};
use super::refusal;
use super::text::ExportTextRequest;

/// Whether this target has the platform codecs and the compositor the native export needs.
///
/// `osg-decode` and `osg-encode` drive Media Foundation and refuse everywhere without an audited
/// backend, so the honest answer is a property of the build rather than of an installed payload.
/// It is not a claim about the graphics device: a machine with no usable adapter refuses at render
/// time with `renderDeviceLost`, which is the only moment that can be known.
const NATIVE_EXPORT_SUPPORTED: bool = cfg!(windows);

/// Whether the native video export can run on this machine.
#[tauri::command]
pub(crate) fn render_runtime_status() -> RenderRuntimeStatusResponse {
    RenderRuntimeStatusResponse {
        available: NATIVE_EXPORT_SUPPORTED,
        // Vestigial: the `WebView` still compares this against its own constant. Nothing this
        // command reports is about Remotion any more.
        remotion_version: REMOTION_VERSION,
        reason: (!NATIVE_EXPORT_SUPPORTED).then_some("runtimePayloadUnavailable"),
        max_concurrent_renders: MAX_CONCURRENT_RENDERS,
    }
}

/// Starts one native video export and streams its progress.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn render_start(
    state: State<'_, DesktopState>,
    runtime: State<'_, RenderRuntimeHost>,
    atlases: State<'_, GlyphAtlasStore>,
    request: RenderRequest,
    text: Option<ExportTextRequest>,
    on_event: Channel<RenderEvent>,
) -> CommandResult<JobSnapshot> {
    let permit = runtime
        .acquire_slot()
        .ok_or_else(CommandError::render_busy)?;
    let text = text.ok_or_else(refusal::text_not_staged)?;
    let staging_root = runtime.staging_root();
    let database = state.database.clone();
    let validated = tauri::async_runtime::spawn_blocking({
        let database = database.clone();
        let atlases = atlases.inner().clone();
        move || prepare::prepare(&database, &atlases, request, text, staging_root)
    })
    .await
    .map_err(|_| CommandError::internal("The render validation task stopped unexpectedly."))??;

    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::RenderVideo).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let started = Instant::now();
    let duration_in_frames = validated.plan.duration_frames;
    diagnostics::record(
        "render.started",
        &[
            ("job", job_id.to_string()),
            ("durationFrames", duration_in_frames.to_string()),
        ],
    );
    if let Err(error) = manifest::initialize(&database, job_id) {
        publish::record_failure(job_id, &error, started);
        let _ = background::finish_failure(&jobs, job_id).await;
        return Err(error);
    }
    let _ = on_event.send(RenderEvent::Progress {
        job: initial.clone(),
        phase: RenderPhaseResponse::Staging,
        fraction_millionths: 0,
        rendered_frames: 0,
        encoded_frames: 0,
        duration_in_frames,
    });

    let runtime = runtime.inner().clone();
    let cancellation = ticket.cancellation().clone();
    let source_asset_id = validated.plan.source_asset_id;
    let project_id = validated.plan.project_id;
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let control = ExportControl::default();
        // One watcher for both ways an export stops early. The time limit is a guard against a
        // wedged pipeline, and it has to stay distinguishable from a cancellation: a job the user
        // stopped is cancelled, and a job the clock stopped failed.
        let watcher = tauri::async_runtime::spawn({
            let control = control.clone();
            async move {
                if tokio::time::timeout(RENDER_TIMEOUT, cancellation.cancelled())
                    .await
                    .is_ok()
                {
                    control.cancel();
                } else {
                    control.time_out();
                }
            }
        });
        let mut progress = ExportProgressSink::new(
            Arc::clone(&jobs),
            job_id,
            on_event.clone(),
            control.clone(),
            started,
            duration_in_frames,
        );
        let exported = tauri::async_runtime::spawn_blocking({
            let control = control.clone();
            move || export::run(validated.inputs, validated.text, &control, &mut progress)
        })
        .await
        .map_err(|_| CommandError::internal("The native export task stopped unexpectedly."))
        .and_then(|result| result);
        watcher.abort();
        publish::finish(
            Publication {
                runtime: &runtime,
                database: &database,
                jobs: &jobs,
                job_id,
                source_asset_id,
                project_id,
                control: &control,
                channel: &on_event,
                started,
            },
            exported,
        )
        .await;
    });
    Ok(initial)
}

/// The result of one render job, with a playback capability when it finished.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn render_result(
    state: State<'_, DesktopState>,
    runtime: State<'_, RenderRuntimeHost>,
    job_id: JobId,
) -> CommandResult<RenderResultResponse> {
    let database = state.database.clone();
    let jobs = Arc::clone(&state.jobs);
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        let job = jobs.get(job_id)?.snapshot().clone();
        if job.kind() != JobKind::RenderVideo {
            return Err(CommandError::invalid_input(
                "The job is not a native video render.",
            ));
        }
        let result = manifest::read_result(&database, &job)?;
        let resolved = result
            .map(|result| {
                let media = manifest::validate_result(&database, job_id, &result)?;
                Ok::<_, CommandError>((result, media.path().to_owned()))
            })
            .transpose()?;
        Ok::<_, CommandError>((job, resolved))
    })
    .await
    .map_err(|_| CommandError::internal("The render result task stopped unexpectedly."))??;
    let result = resolved
        .1
        .map(|(manifest, path)| {
            runtime
                .register_playback(&manifest.asset, &path)
                .map(|playback| RenderCompletedResult::new(manifest, playback))
        })
        .transpose()?;
    Ok(RenderResultResponse {
        job: resolved.0,
        result,
    })
}

/// Gives up a rendered video's playback capability.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn render_playback_release(
    runtime: State<'_, RenderRuntimeHost>,
    playback_id: Uuid,
) -> CommandResult<bool> {
    runtime.release_playback(playback_id)
}
