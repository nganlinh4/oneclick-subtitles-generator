use std::{
    fmt,
    path::PathBuf,
    sync::{Arc, RwLock},
};

use osg_application::{JobRegistry, Session, SessionSnapshot};
use osg_domain::{AssetId, MediaKind};
use osg_infrastructure::secrets::{CredentialService, KeyringCredentialBackend};
use osg_infrastructure::storage::Database;
use osg_media::MediaEngine;
use osg_media_server::{MediaServer, RegisteredMedia};
use osg_providers::{OAuthCoordinator, ProviderClient};
use serde::Serialize;

use crate::asr::AsrRuntimeManager;

#[derive(Debug, Default)]
pub(crate) struct EditorSession {
    pub(crate) session: Session,
    pub(crate) playback: Option<RegisteredMedia>,
    pub(crate) local_media: Option<LocalMedia>,
}

impl EditorSession {
    pub(crate) fn snapshot(&self) -> DesktopSessionSnapshot {
        DesktopSessionSnapshot {
            session: self.session.snapshot(),
            playback: self.playback.clone(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct LocalMedia {
    asset_id: AssetId,
    path: PathBuf,
    mime_type: Option<&'static str>,
    ephemeral_file: Option<Arc<tempfile::NamedTempFile>>,
}

impl LocalMedia {
    #[must_use]
    pub(crate) fn new(asset_id: AssetId, path: PathBuf, kind: MediaKind, extension: &str) -> Self {
        Self {
            asset_id,
            path,
            mime_type: mime_type_for_media(kind, extension),
            ephemeral_file: None,
        }
    }

    #[must_use]
    pub(crate) fn ephemeral(
        asset_id: AssetId,
        kind: MediaKind,
        extension: &str,
        file: Arc<tempfile::NamedTempFile>,
    ) -> Self {
        Self {
            asset_id,
            path: file.path().to_owned(),
            mime_type: mime_type_for_media(kind, extension),
            ephemeral_file: Some(file),
        }
    }

    #[must_use]
    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }

    #[must_use]
    pub(crate) const fn mime_type(&self) -> Option<&'static str> {
        self.mime_type
    }
}

impl fmt::Debug for LocalMedia {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalMedia")
            .field("asset_id", &self.asset_id)
            .field("path", &"<redacted>")
            .field("mime_type", &self.mime_type)
            .field("ephemeral", &self.ephemeral_file.is_some())
            .finish()
    }
}

fn mime_type_for_media(kind: MediaKind, extension: &str) -> Option<&'static str> {
    match (kind, extension.to_ascii_lowercase().as_str()) {
        (MediaKind::Audio, "aac") => Some("audio/aac"),
        (MediaKind::Audio, "aiff") => Some("audio/aiff"),
        (MediaKind::Audio, "flac") => Some("audio/flac"),
        (MediaKind::Audio, "m4a") => Some("audio/mp4"),
        (MediaKind::Audio, "mp3") => Some("audio/mpeg"),
        (MediaKind::Audio, "oga" | "ogg" | "opus") => Some("audio/ogg"),
        (MediaKind::Audio, "wav") => Some("audio/wav"),
        (MediaKind::Audio, "weba") => Some("audio/webm"),
        (MediaKind::Video, "3gp" | "3gpp") => Some("video/3gpp"),
        (MediaKind::Video, "avi") => Some("video/avi"),
        (MediaKind::Video, "flv") => Some("video/x-flv"),
        (MediaKind::Video, "m4v" | "mp4") => Some("video/mp4"),
        (MediaKind::Video, "mov") => Some("video/quicktime"),
        (MediaKind::Video, "mpeg" | "mpg") => Some("video/mpeg"),
        (MediaKind::Video, "webm") => Some("video/webm"),
        (MediaKind::Video, "wmv") => Some("video/wmv"),
        // The editor/ASR pipeline can import more FFmpeg-supported formats. Gemini receives only
        // provider-documented MIME types; every other format must pass through native conversion.
        _ => None,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSessionSnapshot {
    #[serde(flatten)]
    pub(crate) session: SessionSnapshot,
    pub(crate) playback: Option<RegisteredMedia>,
}

#[derive(Debug)]
pub(crate) struct DesktopState {
    pub(crate) editor: RwLock<EditorSession>,
    pub(crate) asr: AsrRuntimeManager,
    pub(crate) database: Database,
    pub(crate) credentials: CredentialService<KeyringCredentialBackend>,
    pub(crate) jobs: Arc<JobRegistry<Database>>,
    pub(crate) media_engine: Option<MediaEngine>,
    pub(crate) media_server: MediaServer,
    pub(crate) providers: ProviderClient,
    pub(crate) youtube_oauth: OAuthCoordinator,
}

impl DesktopState {
    pub(crate) fn new(
        asr: AsrRuntimeManager,
        database: Database,
        jobs: Arc<JobRegistry<Database>>,
        media_engine: Option<MediaEngine>,
        media_server: MediaServer,
    ) -> Self {
        let credentials = CredentialService::platform(database.clone());
        Self {
            editor: RwLock::new(EditorSession::default()),
            asr,
            database,
            credentials,
            jobs,
            media_engine,
            media_server,
            providers: ProviderClient::default(),
            youtube_oauth: OAuthCoordinator::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use osg_domain::MediaKind;

    use super::LocalMedia;

    #[test]
    fn local_media_debug_is_path_redacted_and_mime_mapping_is_strict() {
        let media = LocalMedia::new(
            osg_domain::AssetId::new(),
            PathBuf::from("C:/private/recording.mp4"),
            MediaKind::Video,
            "MP4",
        );
        let debug = format!("{media:?}");

        assert_eq!(media.mime_type(), Some("video/mp4"));
        assert!(!debug.contains("private"));
        assert!(!debug.contains("recording"));
        assert_eq!(
            LocalMedia::new(
                osg_domain::AssetId::new(),
                PathBuf::from("C:/private/recording.mkv"),
                MediaKind::Video,
                "mkv",
            )
            .mime_type(),
            None
        );
        assert_eq!(
            LocalMedia::new(
                osg_domain::AssetId::new(),
                PathBuf::from("C:/private/recording.weba"),
                MediaKind::Audio,
                "weba",
            )
            .mime_type(),
            Some("audio/webm")
        );
        assert_eq!(
            LocalMedia::new(
                osg_domain::AssetId::new(),
                PathBuf::from("C:/private/recording.webm"),
                MediaKind::Video,
                "webm",
            )
            .mime_type(),
            Some("video/webm")
        );
    }
}
