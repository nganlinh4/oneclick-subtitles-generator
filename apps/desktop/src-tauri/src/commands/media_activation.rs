//! Media activation, reopening and project-bound commit of selected media.

use osg_application::ImportedMedia;
use osg_domain::{AssetId, ProjectId};
use osg_infrastructure::storage::Database;
use osg_media_server::{MediaServer, RegisteredMedia};
use tauri::State;
use uuid::Uuid;

use crate::error::{CommandError, CommandResult};
use crate::state::{DesktopSessionSnapshot, DesktopState};

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn clear_media(
    state: State<'_, DesktopState>,
    expected_asset_id: Option<AssetId>,
    expected_playback_id: Option<Uuid>,
) -> CommandResult<DesktopSessionSnapshot> {
    let expected = match (expected_asset_id, expected_playback_id) {
        (None, None) => None,
        (Some(asset_id), Some(playback_id)) => Some((asset_id, playback_id)),
        _ => {
            return Err(CommandError::invalid_input(
                "Both expected media identifiers are required.",
            ));
        }
    };
    clear_activated_media(&state.editor, &state.media_server, expected)
}

pub(super) fn clear_activated_media(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    media_server: &MediaServer,
    expected: Option<(AssetId, Uuid)>,
) -> CommandResult<DesktopSessionSnapshot> {
    let mut editor = editor_state
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    if let Some((expected_asset_id, expected_playback_id)) = expected {
        let exact_media_is_active = editor.pending_media_activation.is_none()
            && editor
                .local_media
                .as_ref()
                .map(crate::state::LocalMedia::asset_id)
                == Some(expected_asset_id)
            && editor.playback.as_ref().map(|playback| playback.id) == Some(expected_playback_id);
        if !exact_media_is_active {
            return Err(CommandError::media_selection_changed());
        }
    }
    advance_media_intent(&mut editor)?;
    editor.pending_media_activation = None;
    let previous = editor.playback.take();
    editor.local_media = None;
    editor.session.clear_media();
    let snapshot = editor.snapshot();
    drop(editor);
    if let Some(previous) = previous {
        media_server.unregister(previous.id)?;
    }
    Ok(snapshot)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ProjectMediaAuthorization {
    pub(super) project_id: ProjectId,
    pub(super) expected_state_version: u64,
}

async fn activate_media_asset_with_policy(
    state: State<'_, DesktopState>,
    id: AssetId,
    authorization: ProjectMediaAuthorization,
    only_if_empty: bool,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    let Some(sequence) = begin_media_activation(&state.editor, id, only_if_empty)? else {
        return Ok(None);
    };
    let database = state.database.clone();
    let media_server = state.media_server.clone();
    let reopened = tauri::async_runtime::spawn_blocking(move || {
        reopen_media_asset(&database, &media_server, authorization, id)
    })
    .await
    .map_err(|_| CommandError::internal("the media reopen task stopped unexpectedly"));
    let (media, playback) = match reopened {
        Ok(Ok(reopened)) => reopened,
        Ok(Err(error)) | Err(error) => {
            cancel_media_activation(&state.editor, sequence, id)?;
            return Err(error);
        }
    };

    commit_authorized_activated_media(
        &state.editor,
        &state.media_server,
        (&state.database, authorization),
        sequence,
        id,
        media,
        playback,
    )
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "temporary compatibility alias until the shared Tauri registration is updated"
)]
pub(crate) async fn open_media_asset(
    state: State<'_, DesktopState>,
    id: AssetId,
    project_id: ProjectId,
    expected_state_version: u64,
    only_if_empty: bool,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    activate_media_asset_with_policy(
        state,
        id,
        ProjectMediaAuthorization {
            project_id,
            expected_state_version,
        },
        only_if_empty,
    )
    .await
}

fn advance_media_intent(editor: &mut crate::state::EditorSession) -> CommandResult<u64> {
    editor.media_intent = editor
        .media_intent
        .checked_add(1)
        .ok_or_else(|| CommandError::internal("the media activation sequence is exhausted"))?;
    Ok(editor.media_intent)
}

pub(super) fn begin_media_activation(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    asset_id: AssetId,
    only_if_empty: bool,
) -> CommandResult<Option<u64>> {
    let mut editor = editor_state
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    if only_if_empty
        && (editor.session.media_path().is_some()
            || editor.playback.is_some()
            || editor.local_media.is_some()
            || editor.pending_media_activation.is_some())
    {
        return Ok(None);
    }
    let sequence = advance_media_intent(&mut editor)?;
    editor.pending_media_activation =
        Some(crate::state::PendingMediaActivation { sequence, asset_id });
    Ok(Some(sequence))
}

fn cancel_media_activation(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    sequence: u64,
    asset_id: AssetId,
) -> CommandResult<()> {
    let mut editor = editor_state
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    let expected = crate::state::PendingMediaActivation { sequence, asset_id };
    if editor.media_intent == sequence && editor.pending_media_activation == Some(expected) {
        editor.pending_media_activation = None;
    }
    Ok(())
}

pub(super) fn invalidate_pending_media_activation(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    asset_id: Option<AssetId>,
) -> CommandResult<()> {
    let mut editor = editor_state
        .write()
        .map_err(|_| CommandError::internal("the editing session is unavailable"))?;
    if editor
        .pending_media_activation
        .is_some_and(|pending| asset_id.is_none_or(|id| pending.asset_id == id))
    {
        advance_media_intent(&mut editor)?;
        editor.pending_media_activation = None;
    }
    Ok(())
}

pub(super) fn commit_activated_media(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    media_server: &MediaServer,
    sequence: u64,
    asset_id: AssetId,
    media: ImportedMedia,
    playback: RegisteredMedia,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    commit_activated_media_with_authorization(
        editor_state,
        media_server,
        None,
        sequence,
        asset_id,
        media,
        playback,
    )
}

pub(super) fn commit_authorized_activated_media(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    media_server: &MediaServer,
    // The database and the revision it authorizes are only meaningful together.
    authorization: (&Database, ProjectMediaAuthorization),
    sequence: u64,
    asset_id: AssetId,
    media: ImportedMedia,
    playback: RegisteredMedia,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    commit_activated_media_with_authorization(
        editor_state,
        media_server,
        Some(authorization),
        sequence,
        asset_id,
        media,
        playback,
    )
}

fn commit_activated_media_with_authorization(
    editor_state: &std::sync::RwLock<crate::state::EditorSession>,
    media_server: &MediaServer,
    authorization: Option<(&Database, ProjectMediaAuthorization)>,
    sequence: u64,
    asset_id: AssetId,
    media: ImportedMedia,
    playback: RegisteredMedia,
) -> CommandResult<Option<DesktopSessionSnapshot>> {
    if media.asset().id() != asset_id {
        let _ = media_server.unregister(playback.id);
        return Err(CommandError::internal(
            "the verified media identity did not match the activation intent",
        ));
    }
    let Ok(mut editor) = editor_state.write() else {
        let _ = media_server.unregister(playback.id);
        return Err(CommandError::internal("the editing session is unavailable"));
    };
    let expected = crate::state::PendingMediaActivation { sequence, asset_id };
    if editor.media_intent != sequence || editor.pending_media_activation != Some(expected) {
        drop(editor);
        let _ = media_server.unregister(playback.id);
        return Ok(None);
    }
    if let Some((database, authorization)) = authorization {
        let authorized = database.project_media_is_current(
            authorization.project_id,
            authorization.expected_state_version,
            asset_id,
        );
        match authorized {
            Ok(true) => {}
            Ok(false) => {
                editor.pending_media_activation = None;
                drop(editor);
                let _ = media_server.unregister(playback.id);
                return Err(CommandError::media_unavailable());
            }
            Err(error) => {
                editor.pending_media_activation = None;
                drop(editor);
                let _ = media_server.unregister(playback.id);
                return Err(error.into());
            }
        }
    }
    let previous = editor.playback.replace(playback);
    editor.local_media = Some(crate::state::LocalMedia::new(
        media.asset().id(),
        media.canonical_path().to_owned(),
        media.asset().kind(),
        media.asset().extension(),
    ));
    editor.session.set_media(media);
    editor.pending_media_activation = None;
    let snapshot = editor.snapshot();
    drop(editor);
    if let Some(previous) = previous {
        let _ = media_server.unregister(previous.id);
    }
    Ok(Some(snapshot))
}

pub(super) fn reopen_media_asset(
    database: &Database,
    media_server: &MediaServer,
    authorization: ProjectMediaAuthorization,
    id: AssetId,
) -> CommandResult<(ImportedMedia, RegisteredMedia)> {
    let resolved = database
        .resolve_project_media_revision(
            authorization.project_id,
            authorization.expected_state_version,
            id,
        )?
        .ok_or_else(CommandError::media_unavailable)?;
    register_resolved_media(media_server, &resolved)
}

pub(super) fn reopen_media_asset_unowned(
    database: &Database,
    media_server: &MediaServer,
    id: AssetId,
) -> CommandResult<(ImportedMedia, RegisteredMedia)> {
    let resolved = database
        .resolve_media(id)?
        .ok_or_else(CommandError::media_unavailable)?;
    register_resolved_media(media_server, &resolved)
}

fn register_resolved_media(
    media_server: &MediaServer,
    resolved: &osg_infrastructure::storage::ResolvedMedia,
) -> CommandResult<(ImportedMedia, RegisteredMedia)> {
    let media = ImportedMedia::from_verified_native_asset(
        resolved.asset().clone(),
        resolved.path().to_owned(),
    )?;
    let playback = media_server.register_content_snapshot_with_extension(
        resolved.verified_file().as_ref(),
        media.asset().extension(),
        media.asset().size_bytes(),
        *resolved.content_hash().as_bytes(),
    )?;
    if let Err(error) = resolved.revalidate_verified_file() {
        let _ = media_server.unregister(playback.id);
        return Err(error.into());
    }
    Ok((media, playback))
}
