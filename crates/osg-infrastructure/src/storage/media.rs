use std::ffi::OsString;
use std::io::{BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use osg_domain::{AssetId, JobId, MediaAsset, MediaKind};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

use super::artifacts::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRegistration, ContentHash,
};
use super::{Database, DatabaseError};

const MAX_PATH_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct ResolvedMedia {
    asset: MediaAsset,
    path: PathBuf,
}

#[derive(Clone)]
pub struct PublishedMedia {
    asset: MediaAsset,
    artifact_id: ArtifactId,
    path: PathBuf,
}

impl PublishedMedia {
    #[must_use]
    pub const fn asset(&self) -> &MediaAsset {
        &self.asset
    }

    #[must_use]
    pub const fn artifact_id(&self) -> ArtifactId {
        self.artifact_id
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl std::fmt::Debug for PublishedMedia {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PublishedMedia")
            .field("asset", &self.asset)
            .field("artifact_id", &self.artifact_id)
            .field("path", &"<redacted>")
            .finish()
    }
}

/// Publishes a verified media file into durable content-addressed storage and
/// remembers its independent opaque media identity. The final artifact path is
/// intentionally extensionless; playback must use the asset's trusted MIME or
/// extension metadata rather than re-inspecting that path.
pub fn publish_durable_media(
    database: &Database,
    job_id: JobId,
    kind: ArtifactKind,
    asset: MediaAsset,
    source_path: &Path,
    metadata: Value,
) -> Result<PublishedMedia, DatabaseError> {
    let source_metadata =
        std::fs::symlink_metadata(source_path).map_err(|_| DatabaseError::InvalidArtifactFile)?;
    if !source_metadata.file_type().is_file()
        || source_metadata.file_type().is_symlink()
        || source_metadata.len() != asset.size_bytes()
    {
        return Err(DatabaseError::InvalidArtifactFile);
    }
    let source = std::fs::File::open(source_path)?;
    let mut source = BufReader::new(source);
    let content_hash = ContentHash::digest_reader(&mut source)?;
    source.seek(SeekFrom::Start(0))?;
    let draft =
        ArtifactDraft::new(kind, content_hash, asset.size_bytes(), metadata)?.with_job(job_id);
    let artifact_id = match database.register_artifact(&draft)? {
        ArtifactRegistration::Existing(record) => record.id(),
        ArtifactRegistration::Staging(staging) => {
            let artifact_id = staging.record().id();
            let publication = (|| -> std::io::Result<()> {
                let mut target = std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(staging.path())?;
                let copied = std::io::copy(&mut source, &mut target)?;
                if copied != asset.size_bytes() {
                    return Err(std::io::Error::other("media artifact size changed"));
                }
                target.sync_all()
            })();
            if let Err(error) = publication {
                fail_publication(database, artifact_id);
                return Err(error.into());
            }
            if let Err(error) = database.mark_artifact_ready(artifact_id) {
                fail_publication(database, artifact_id);
                return Err(error);
            }
            artifact_id
        }
    };
    let resolved = database
        .resolve_artifact(artifact_id)?
        .ok_or(DatabaseError::ArtifactNotFound(artifact_id))?;
    database.remember_media(&asset, resolved.path())?;
    Ok(PublishedMedia {
        asset,
        artifact_id,
        path: resolved.path().to_owned(),
    })
}

fn fail_publication(database: &Database, artifact_id: ArtifactId) {
    if let Ok(code) = ArtifactFailureCode::new("mediaPublish") {
        let _ = database.mark_artifact_failed(artifact_id, &code);
    }
}

impl ResolvedMedia {
    #[must_use]
    pub const fn asset(&self) -> &MediaAsset {
        &self.asset
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl std::fmt::Debug for ResolvedMedia {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedMedia")
            .field("asset", &self.asset)
            .field("path", &"<redacted>")
            .finish()
    }
}

pub(super) fn remember(
    connection: &mut Connection,
    asset: &MediaAsset,
    canonical_path: &Path,
) -> Result<(), DatabaseError> {
    validate_native_file(asset, canonical_path)?;
    let path_bytes = encode_path(canonical_path)?;
    let size_bytes =
        i64::try_from(asset.size_bytes()).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let timestamp = super::actor::now_ms();
    let transaction = connection.transaction()?;
    let existing = transaction
        .query_row(
            "SELECT kind, display_name, extension, size_bytes
             FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    if existing.as_ref().is_some_and(|existing| {
        existing.0 != media_kind_name(asset.kind())
            || existing.1 != asset.display_name()
            || existing.2 != asset.extension()
            || existing.3 != size_bytes
    }) {
        return Err(DatabaseError::MediaAssetMismatch(asset.id()));
    }
    transaction.execute(
        "INSERT OR IGNORE INTO media_assets(
           id, kind, display_name, extension, size_bytes, metadata_json, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6)",
        params![
            asset.id().as_uuid(),
            media_kind_name(asset.kind()),
            asset.display_name(),
            asset.extension(),
            size_bytes,
            timestamp,
        ],
    )?;
    transaction.execute(
        "INSERT INTO media_locations(
           id, media_id, path_bytes, path_encoding, platform, available,
           last_verified_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
         ON CONFLICT(media_id, path_bytes, path_encoding) DO UPDATE SET
           platform = excluded.platform,
           available = 1,
           last_verified_at_ms = excluded.last_verified_at_ms",
        params![
            Uuid::now_v7(),
            asset.id().as_uuid(),
            path_bytes,
            path_encoding(),
            platform_name(),
            timestamp,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn resolve(
    connection: &mut Connection,
    id: AssetId,
) -> Result<Option<ResolvedMedia>, DatabaseError> {
    let stored_asset = connection
        .query_row(
            "SELECT display_name, extension, size_bytes, kind
             FROM media_assets WHERE id = ?1",
            [id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((display_name, extension, size_bytes, kind)) = stored_asset else {
        return Ok(None);
    };
    let size_bytes = u64::try_from(size_bytes).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let kind = match kind.as_str() {
        "audio" => MediaKind::Audio,
        "video" => MediaKind::Video,
        _ => return Err(DatabaseError::InvalidMediaLocation),
    };
    let asset = MediaAsset::with_id(id, display_name, extension, size_bytes, kind)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let mut statement = connection.prepare(
        "SELECT id, path_bytes, path_encoding
         FROM media_locations
         WHERE media_id = ?1 AND platform = ?2
         ORDER BY available DESC, last_verified_at_ms DESC, id",
    )?;
    let rows = statement.query_map(params![id.as_uuid(), platform_name()], |row| {
        Ok((
            row.get::<_, Uuid>(0)?,
            row.get::<_, Vec<u8>>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut candidates = Vec::new();
    for row in rows {
        candidates.push(row?);
    }
    drop(statement);

    let timestamp = super::actor::now_ms();
    for (location_id, bytes, encoding) in candidates {
        let path = decode_path(&bytes, &encoding);
        let available = path.as_ref().is_some_and(|path| {
            std::fs::metadata(path)
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() == asset.size_bytes())
        });
        connection.execute(
            "UPDATE media_locations
             SET available = ?1, last_verified_at_ms = ?2 WHERE id = ?3",
            params![available, timestamp, location_id],
        )?;
        if available {
            return Ok(path.map(|path| ResolvedMedia {
                asset: asset.clone(),
                path,
            }));
        }
    }
    Ok(None)
}

fn validate_native_file(asset: &MediaAsset, path: &Path) -> Result<(), DatabaseError> {
    if !path.is_absolute() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let metadata = std::fs::metadata(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    if !metadata.is_file() || metadata.len() != asset.size_bytes() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok(())
}

fn encode_path(path: &Path) -> Result<Vec<u8>, DatabaseError> {
    #[cfg(windows)]
    let bytes = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    if bytes.is_empty() || bytes.len() > MAX_PATH_BYTES {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok(bytes)
}

fn decode_path(bytes: &[u8], encoding: &str) -> Option<PathBuf> {
    if bytes.is_empty() || bytes.len() > MAX_PATH_BYTES || encoding != path_encoding() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        if !bytes.len().is_multiple_of(2) {
            return None;
        }
        let wide = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        Some(PathBuf::from(OsString::from_wide(&wide)))
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(OsString::from_vec(bytes.to_vec())))
    }
}

const fn path_encoding() -> &'static str {
    if cfg!(windows) {
        "windows-utf16le"
    } else {
        "unix-bytes"
    }
}

const fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

const fn media_kind_name(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}

#[cfg(test)]
mod tests {
    use osg_domain::{JobId, JobKind, JobSnapshot, MediaAsset, MediaKind};

    use super::{decode_path, encode_path, path_encoding, publish_durable_media};
    use crate::storage::ArtifactKind;

    #[test]
    fn native_path_encoding_is_lossless() {
        let path = std::env::current_dir()
            .expect("current directory")
            .join("unicode-한글-media.mp4");
        let encoded = encode_path(&path).expect("encoded path");
        assert_eq!(
            decode_path(&encoded, path_encoding()).as_deref(),
            Some(path.as_path())
        );
        assert!(decode_path(&encoded, "wrong-encoding").is_none());
    }

    #[test]
    fn durable_location_round_trips_and_rejects_asset_identity_mismatch() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database =
            super::super::Database::open(directory.path().join("osg.sqlite3")).expect("database");
        let path = directory.path().join("selected.mp4");
        std::fs::write(&path, b"media").expect("fixture");
        let asset = MediaAsset::new("selected.mp4", "mp4", 5, MediaKind::Video).expect("asset");

        database.remember_media(&asset, &path).expect("remember");
        assert_eq!(
            database
                .resolve_media(asset.id())
                .expect("resolve")
                .as_ref()
                .map(super::ResolvedMedia::path),
            Some(std::fs::canonicalize(&path).expect("canonical").as_path())
        );

        let mismatch = MediaAsset::with_id(asset.id(), "different.mp4", "mp4", 5, MediaKind::Video)
            .expect("mismatch asset");
        assert!(matches!(
            database.remember_media(&mismatch, &path),
            Err(super::super::DatabaseError::MediaAssetMismatch(id)) if id == asset.id()
        ));

        std::fs::write(&path, b"changed-size").expect("change fixture");
        assert!(
            database
                .resolve_media(asset.id())
                .expect("resolve missing")
                .is_none()
        );
    }

    #[test]
    fn durable_media_publication_retains_extensions_as_metadata_and_reuses_bytes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = super::super::Database::open_with_artifact_root(
            directory.path().join("db/osg.sqlite3"),
            directory.path().join("artifacts"),
        )
        .expect("database");
        let job_id = JobId::new();
        database
            .create_job(&JobSnapshot::with_id(job_id, JobKind::RenderVideo))
            .expect("job");
        let source = directory.path().join("clip.mp4");
        std::fs::write(&source, b"durable clip bytes").expect("source");
        let first_asset =
            MediaAsset::new("clip.mp4", "mp4", 18, MediaKind::Video).expect("first asset");
        let first = publish_durable_media(
            &database,
            job_id,
            ArtifactKind::new("analysisClip").expect("kind"),
            first_asset.clone(),
            &source,
            serde_json::json!({"purpose": "geminiSegment"}),
        )
        .expect("first publication");
        assert!(first.path().extension().is_none());
        assert_eq!(first.asset(), &first_asset);
        assert!(!format!("{first:?}").contains(directory.path().to_string_lossy().as_ref()));

        let second_asset =
            MediaAsset::new("clip.mp4", "mp4", 18, MediaKind::Video).expect("second opaque asset");
        let second = publish_durable_media(
            &database,
            job_id,
            ArtifactKind::new("analysisClip").expect("kind"),
            second_asset.clone(),
            &source,
            serde_json::json!({"purpose": "geminiSegment"}),
        )
        .expect("deduplicated publication");
        assert_ne!(first_asset.id(), second_asset.id());
        assert_eq!(first.artifact_id(), second.artifact_id());
        assert_eq!(first.path(), second.path());

        std::fs::remove_file(&source).expect("remove transient source");
        database.clear_all_cache().expect("clear derived cache");
        for asset in [first_asset, second_asset] {
            let resolved = database
                .resolve_media(asset.id())
                .expect("resolve")
                .expect("durable media");
            assert_eq!(resolved.asset(), &asset);
            assert_eq!(
                std::fs::read(resolved.path()).expect("durable bytes"),
                b"durable clip bytes"
            );
        }
    }
}
