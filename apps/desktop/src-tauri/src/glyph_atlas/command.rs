//! The command

use osg_domain::AssetId;
use serde::Serialize;
use tauri::State;
use tauri::ipc::{InvokeBody, Request};

use super::CONTENT_TYPE_HEADER;
use super::decode::decode_frame;
use super::refusal::StagingRefusal;
use super::registry::GlyphAtlasStore;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};

fn record_refusal(refusal: StagingRefusal) -> CommandError {
    diagnostics::record(
        "glyph-atlas.staging_refused",
        &[("reason", refusal.code().to_owned())],
    );
    refusal.into()
}

/// The whole of what staging returns: an opaque handle and the hash the caller sent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlyphAtlasStageResponse {
    atlas_id: AssetId,
    content_hash: String,
}

/// Stages one baked glyph atlas frame and returns an opaque handle for it.
#[tauri::command]
#[allow(
    dead_code,
    reason = "reachable once lib.rs registers the command; remove with the wiring change"
)]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Request as owned command extractors"
)]
pub(crate) fn glyph_atlas_stage(
    store: State<'_, GlyphAtlasStore>,
    request: Request<'_>,
) -> CommandResult<GlyphAtlasStageResponse> {
    let media_type = request
        .headers()
        .get(CONTENT_TYPE_HEADER)
        .and_then(|value| value.to_str().ok());
    let InvokeBody::Raw(frame) = request.body() else {
        return Err(record_refusal(StagingRefusal::UnsupportedBody));
    };
    let atlas = decode_frame(media_type, frame).map_err(record_refusal)?;
    let content_hash = atlas.content_hash().to_owned();
    let atlas_id = store.stage(atlas).map_err(record_refusal)?;
    Ok(GlyphAtlasStageResponse {
        atlas_id,
        content_hash,
    })
}
