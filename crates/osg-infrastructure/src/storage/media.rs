use std::ffi::OsString;
use std::io::{BufReader, Read, Seek, SeekFrom};
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
pub(super) const MAX_MEDIA_LOCATION_CANDIDATES: usize = 64;

pub(super) struct MediaResolutionPlan {
    pub(super) asset: MediaAsset,
    pub(super) content_hash: Option<ContentHash>,
    pub(super) candidates: Vec<MediaLocationCandidate>,
    pub(super) has_more_candidates: bool,
}

pub(super) struct MediaLocationCandidate {
    pub(super) id: Uuid,
    pub(super) path: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct MediaFileIdentity {
    size_bytes: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
    #[cfg(windows)]
    creation_time: u64,
    #[cfg(windows)]
    last_write_time: u64,
}

#[cfg(unix)]
#[must_use]
pub(super) const fn media_file_identity_cacheable(identity: MediaFileIdentity) -> bool {
    identity.modified.is_some()
}

pub(super) struct VerifiedMediaFile {
    pub(super) content_hash: ContentHash,
    #[cfg(unix)]
    pub(super) identity: MediaFileIdentity,
}

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
    pub(super) const fn new(asset: MediaAsset, path: PathBuf) -> Self {
        Self { asset, path }
    }

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
    content_hash: ContentHash,
) -> Result<Uuid, DatabaseError> {
    if !canonical_path.is_absolute() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let path_bytes = encode_path(canonical_path)?;
    let size_bytes =
        i64::try_from(asset.size_bytes()).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let timestamp = super::actor::now_ms();
    let transaction = connection.transaction()?;
    let existing = transaction
        .query_row(
            "SELECT kind, display_name, extension, size_bytes, content_hash
             FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                ))
            },
        )
        .optional()?;
    if existing.as_ref().is_some_and(|existing| {
        existing.0 != media_kind_name(asset.kind())
            || existing.1 != asset.display_name()
            || existing.2 != asset.extension()
            || existing.3 != size_bytes
            || existing
                .4
                .as_ref()
                .is_some_and(|stored| stored.as_slice() != content_hash.as_bytes())
    }) {
        return Err(DatabaseError::MediaAssetMismatch(asset.id()));
    }
    transaction.execute(
        "INSERT OR IGNORE INTO media_assets(
           id, kind, display_name, extension, size_bytes, content_hash,
           metadata_json, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7)",
        params![
            asset.id().as_uuid(),
            media_kind_name(asset.kind()),
            asset.display_name(),
            asset.extension(),
            size_bytes,
            content_hash.as_bytes().as_slice(),
            timestamp,
        ],
    )?;
    transaction.execute(
        "UPDATE media_assets SET content_hash = ?1
         WHERE id = ?2 AND content_hash IS NULL",
        params![content_hash.as_bytes().as_slice(), asset.id().as_uuid()],
    )?;
    let proposed_location_id = Uuid::now_v7();
    let location_id = transaction.query_row(
        "INSERT INTO media_locations(
           id, media_id, path_bytes, path_encoding, platform, available,
           last_verified_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
         ON CONFLICT(media_id, path_bytes, path_encoding) DO UPDATE SET
           platform = excluded.platform,
           available = 1,
           last_verified_at_ms = excluded.last_verified_at_ms
         RETURNING id",
        params![
            proposed_location_id,
            asset.id().as_uuid(),
            path_bytes,
            path_encoding(),
            platform_name(),
            timestamp,
        ],
        |row| row.get(0),
    )?;
    let offset = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    transaction.execute(
        "DELETE FROM media_locations
         WHERE id IN (
           SELECT id FROM media_locations
           WHERE media_id = ?1
           ORDER BY (id = ?2) DESC, available DESC, last_verified_at_ms DESC, id
           LIMIT -1 OFFSET ?3
         )",
        params![asset.id().as_uuid(), location_id, offset],
    )?;
    transaction.commit()?;
    Ok(location_id)
}

pub(super) fn resolution_plan(
    connection: &Connection,
    id: AssetId,
) -> Result<Option<MediaResolutionPlan>, DatabaseError> {
    let stored_asset = connection
        .query_row(
            "SELECT display_name, extension, size_bytes, kind, content_hash
             FROM media_assets WHERE id = ?1",
            [id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((display_name, extension, size_bytes, kind, content_hash)) = stored_asset else {
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
    let content_hash = content_hash
        .map(|bytes| {
            <[u8; 32]>::try_from(bytes)
                .map(ContentHash::from_bytes)
                .map_err(|_| DatabaseError::InvalidMediaLocation)
        })
        .transpose()?;
    let mut statement = connection.prepare(
        "SELECT id, path_bytes, path_encoding
         FROM media_locations
         WHERE media_id = ?1 AND platform = ?2
         ORDER BY available DESC,
                  CASE WHEN available = 1 THEN last_verified_at_ms END DESC,
                  CASE WHEN available = 0 THEN last_verified_at_ms END ASC,
                  id
         LIMIT ?3",
    )?;
    let candidate_limit = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES + 1)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let rows = statement.query_map(
        params![id.as_uuid(), platform_name(), candidate_limit],
        |row| {
            Ok((
                row.get::<_, Uuid>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )?;
    let mut candidates = Vec::new();
    for row in rows {
        candidates.push(row?);
    }
    drop(statement);
    let has_more_candidates = candidates.len() > MAX_MEDIA_LOCATION_CANDIDATES;
    candidates.truncate(MAX_MEDIA_LOCATION_CANDIDATES);
    Ok(Some(MediaResolutionPlan {
        asset,
        content_hash,
        candidates: candidates
            .into_iter()
            .map(|(location_id, bytes, encoding)| MediaLocationCandidate {
                id: location_id,
                path: decode_path(&bytes, &encoding),
            })
            .collect(),
        has_more_candidates,
    }))
}

pub(super) fn mark_location(
    connection: &mut Connection,
    media_id: AssetId,
    location_id: Uuid,
    available: bool,
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    let changed = transaction.execute(
        "UPDATE media_locations
         SET available = ?1, last_verified_at_ms = ?2
         WHERE id = ?3 AND media_id = ?4",
        params![
            available,
            super::actor::now_ms(),
            location_id,
            media_id.as_uuid(),
        ],
    )?;
    if changed != 1 {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let location_count: i64 = transaction.query_row(
        "SELECT count(*) FROM media_locations WHERE media_id = ?1",
        [media_id.as_uuid()],
        |row| row.get(0),
    )?;
    if usize::try_from(location_count).map_err(|_| DatabaseError::InvalidMediaLocation)?
        > MAX_MEDIA_LOCATION_CANDIDATES
    {
        if available {
            let offset = i64::try_from(MAX_MEDIA_LOCATION_CANDIDATES)
                .map_err(|_| DatabaseError::InvalidMediaLocation)?;
            transaction.execute(
                "DELETE FROM media_locations
                 WHERE id IN (
                   SELECT id FROM media_locations
                   WHERE media_id = ?1
                   ORDER BY available DESC,
                            CASE WHEN available = 1 THEN last_verified_at_ms END DESC,
                            CASE WHEN available = 0 THEN last_verified_at_ms END ASC,
                            id
                   LIMIT -1 OFFSET ?2
                 )",
                params![media_id.as_uuid(), offset],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM media_locations WHERE id = ?1 AND media_id = ?2",
                params![location_id, media_id.as_uuid()],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(unix)]
pub(super) fn inspect_media_file(
    path: &Path,
    expected_size: u64,
) -> Result<MediaFileIdentity, DatabaseError> {
    if !path.is_absolute() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let file = std::fs::File::open(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let metadata = file
        .metadata()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok(media_file_identity(&metadata))
}

pub(super) fn digest_media_file(
    path: &Path,
    expected_size: u64,
) -> Result<VerifiedMediaFile, DatabaseError> {
    digest_media_file_with_post_hash(path, expected_size, || {})
}

fn digest_media_file_with_post_hash(
    path: &Path,
    expected_size: u64,
    post_hash: impl FnOnce(),
) -> Result<VerifiedMediaFile, DatabaseError> {
    if !path.is_absolute() {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let file = std::fs::File::open(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let hashed_handle = same_file::Handle::from_file(
        file.try_clone()
            .map_err(|_| DatabaseError::InvalidMediaLocation)?,
    )
    .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let before = file
        .metadata()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    if !before.is_file() || before.len() != expected_size {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    let before_identity = media_file_identity(&before);
    let read_limit = expected_size
        .checked_add(1)
        .ok_or(DatabaseError::InvalidMediaLocation)?;
    let mut bounded = BufReader::new(&file).take(read_limit);
    let content_hash = ContentHash::digest_reader(&mut bounded)
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let remaining = bounded.limit();
    drop(bounded);
    post_hash();

    let after = file
        .metadata()
        .map_err(|_| DatabaseError::InvalidMediaLocation)?;
    let after_identity = media_file_identity(&after);
    let current_path_handle =
        same_file::Handle::from_path(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
    if remaining != 1
        || !after.is_file()
        || after.len() != expected_size
        || before_identity != after_identity
        || hashed_handle != current_path_handle
    {
        return Err(DatabaseError::InvalidMediaLocation);
    }
    Ok(VerifiedMediaFile {
        content_hash,
        #[cfg(unix)]
        identity: after_identity,
    })
}

fn media_file_identity(metadata: &std::fs::Metadata) -> MediaFileIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        MediaFileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
            device: metadata.dev(),
            inode: metadata.ino(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        MediaFileIdentity {
            size_bytes: metadata.file_size(),
            modified: metadata.modified().ok(),
            creation_time: metadata.creation_time(),
            last_write_time: metadata.last_write_time(),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        MediaFileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
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
    use rusqlite::params;
    use uuid::Uuid;

    use super::{
        decode_path, digest_media_file, digest_media_file_with_post_hash, encode_path,
        path_encoding, platform_name, publish_durable_media,
    };
    use crate::storage::{ArtifactKind, ContentHash, DatabaseError};

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
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let path = directory.path().join("selected.mp4");
        std::fs::write(&path, b"media").expect("fixture");
        let asset = MediaAsset::new("selected.mp4", "mp4", 5, MediaKind::Video).expect("asset");

        database.remember_media(&asset, &path).expect("remember");
        let stored_hash: Vec<u8> = rusqlite::Connection::open(&database_path)
            .expect("inspect database")
            .query_row(
                "SELECT content_hash FROM media_assets WHERE id = ?1",
                [asset.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("stored media hash");
        assert_eq!(stored_hash, ContentHash::digest(b"media").as_bytes());
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

        std::fs::write(&path, b"other").expect("replace with same-size content");
        assert!(
            database
                .resolve_media(asset.id())
                .expect("resolve changed content")
                .is_none()
        );
        assert!(matches!(
            database.remember_media(&asset, &path),
            Err(DatabaseError::MediaAssetMismatch(id)) if id == asset.id()
        ));

        std::fs::write(&path, b"media").expect("restore original content");
        assert!(
            database
                .resolve_media(asset.id())
                .expect("resolve restored content")
                .is_some()
        );
    }

    #[test]
    fn legacy_media_without_a_content_hash_fails_closed_until_reselected() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let path = directory.path().join("legacy.mp4");
        std::fs::write(&path, b"legacy").expect("fixture");
        let asset = MediaAsset::new("legacy.mp4", "mp4", 6, MediaKind::Video).expect("asset");
        database.remember_media(&asset, &path).expect("remember");

        let connection = rusqlite::Connection::open(&database_path).expect("inspect database");
        connection
            .execute(
                "UPDATE media_assets SET content_hash = NULL WHERE id = ?1",
                params![asset.id().as_uuid()],
            )
            .expect("simulate legacy null hash");
        drop(connection);

        assert!(
            database
                .resolve_media(asset.id())
                .expect("legacy resolve")
                .is_none()
        );
        database
            .remember_media(&asset, &path)
            .expect("explicit reselection fills hash");
        assert!(
            database
                .resolve_media(asset.id())
                .expect("reselected resolve")
                .is_some()
        );
    }

    #[test]
    fn bounded_media_digest_rejects_growth_and_shrinkage() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("bounded.mp4");
        std::fs::write(&path, b"media").expect("fixture");
        let canonical = std::fs::canonicalize(&path).expect("canonical fixture");

        let verified = digest_media_file(&canonical, 5).expect("exact digest");
        assert_eq!(verified.content_hash, ContentHash::digest(b"media"));
        assert!(matches!(
            digest_media_file(&canonical, 4),
            Err(DatabaseError::InvalidMediaLocation)
        ));
        assert!(matches!(
            digest_media_file(&canonical, 6),
            Err(DatabaseError::InvalidMediaLocation)
        ));
    }

    #[test]
    fn bounded_media_digest_rejects_a_path_replaced_after_the_handle_was_hashed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("selected.mp4");
        let displaced = directory.path().join("displaced.mp4");
        std::fs::write(&path, b"media").expect("fixture");
        let canonical = std::fs::canonicalize(&path).expect("canonical fixture");

        let result = digest_media_file_with_post_hash(&canonical, 5, || {
            std::fs::rename(&canonical, &displaced).expect("displace opened file");
            std::fs::write(&canonical, b"media").expect("same-size replacement");
        });

        assert!(matches!(result, Err(DatabaseError::InvalidMediaLocation)));
    }

    #[test]
    fn media_locations_are_compacted_to_the_explicit_per_asset_cap() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");

        for index in 0..super::MAX_MEDIA_LOCATION_CANDIDATES {
            let path = directory.path().join(format!("clip-{index}.mp4"));
            std::fs::write(&path, b"media").expect("media fixture");
            database
                .remember_media(&asset, &path)
                .expect("bounded location");
        }
        let overflow = directory.path().join("clip-overflow.mp4");
        std::fs::write(&overflow, b"media").expect("overflow fixture");
        database
            .remember_media(&asset, &overflow)
            .expect("newest location compacts the oldest");
        let retained: i64 = rusqlite::Connection::open(&database_path)
            .expect("inspect compacted locations")
            .query_row(
                "SELECT count(*) FROM media_locations WHERE media_id = ?1",
                [asset.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("retained count");
        assert_eq!(
            retained,
            i64::try_from(super::MAX_MEDIA_LOCATION_CANDIDATES).expect("cap")
        );
        assert!(
            database
                .resolve_media(asset.id())
                .expect("bounded resolve")
                .is_some()
        );
    }

    #[test]
    fn null_hash_legacy_overflow_can_be_reselected_and_keeps_the_selected_path() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let selected = directory.path().join("selected.mp4");
        std::fs::write(&selected, b"media").expect("selected fixture");
        let selected = std::fs::canonicalize(selected).expect("canonical selected fixture");
        let selected_bytes = encode_path(&selected).expect("encoded selected path");
        let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
        database
            .remember_media(&asset, &selected)
            .expect("initial selection");

        let mut connection = rusqlite::Connection::open(&database_path).expect("seed legacy rows");
        let transaction = connection.transaction().expect("legacy transaction");
        transaction
            .execute(
                "UPDATE media_assets SET content_hash = NULL WHERE id = ?1",
                [asset.id().as_uuid()],
            )
            .expect("legacy null hash");
        let hostile_timestamp = i64::MAX - 1;
        for index in 0..super::MAX_MEDIA_LOCATION_CANDIDATES {
            let legacy_path = directory.path().join(format!("legacy-{index}.mp4"));
            std::fs::write(&legacy_path, b"media").expect("legacy fixture");
            let legacy_path = std::fs::canonicalize(legacy_path).expect("canonical legacy fixture");
            transaction
                .execute(
                    "INSERT INTO media_locations(
                       id, media_id, path_bytes, path_encoding, platform, available,
                       last_verified_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                    params![
                        Uuid::now_v7(),
                        asset.id().as_uuid(),
                        encode_path(&legacy_path).expect("encoded legacy path"),
                        path_encoding(),
                        platform_name(),
                        hostile_timestamp,
                    ],
                )
                .expect("overflow legacy location");
        }
        transaction.commit().expect("legacy overflow");

        database
            .remember_media(&asset, &selected)
            .expect("explicit reselection repairs null hash and overflow");
        let (retained, selected_retained, hash): (i64, i64, Vec<u8>) = connection
            .query_row(
                "SELECT
                   (SELECT count(*) FROM media_locations WHERE media_id = ?1),
                   (SELECT count(*) FROM media_locations
                    WHERE media_id = ?1 AND path_bytes = ?2 AND path_encoding = ?3),
                   content_hash
                 FROM media_assets WHERE id = ?1",
                params![asset.id().as_uuid(), selected_bytes, path_encoding()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("repaired legacy state");
        assert_eq!(
            retained,
            i64::try_from(super::MAX_MEDIA_LOCATION_CANDIDATES).expect("cap")
        );
        assert_eq!(selected_retained, 1);
        assert_eq!(hash, ContentHash::digest(b"media").as_bytes());
        let resolved = database
            .resolve_media(asset.id())
            .expect("resolve repaired asset")
            .expect("repaired media");
        assert_eq!(
            std::fs::read(resolved.path()).expect("resolved repaired bytes"),
            b"media"
        );
    }

    #[test]
    fn oversized_legacy_location_sets_recover_a_valid_tail_and_compact_to_the_cap() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let valid_path = directory.path().join("valid.mp4");
        std::fs::write(&valid_path, b"media").expect("valid fixture");
        let valid_path = std::fs::canonicalize(valid_path).expect("canonical valid fixture");
        let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
        database
            .remember_media(&asset, &valid_path)
            .expect("remember valid tail");

        let mut connection = rusqlite::Connection::open(&database_path).expect("seed legacy rows");
        let transaction = connection.transaction().expect("legacy transaction");
        transaction
            .execute(
                "UPDATE media_locations
                 SET available = 0, last_verified_at_ms = 1
                 WHERE media_id = ?1",
                [asset.id().as_uuid()],
            )
            .expect("demote valid legacy tail");
        for index in 0..super::MAX_MEDIA_LOCATION_CANDIDATES {
            let invalid_path = directory.path().join(format!("invalid-{index}.mp4"));
            std::fs::write(&invalid_path, b"other").expect("invalid fixture");
            let invalid_path =
                std::fs::canonicalize(invalid_path).expect("canonical invalid fixture");
            transaction
                .execute(
                    "INSERT INTO media_locations(
                       id, media_id, path_bytes, path_encoding, platform, available,
                       last_verified_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, 2)",
                    params![
                        Uuid::now_v7(),
                        asset.id().as_uuid(),
                        encode_path(&invalid_path).expect("encoded invalid path"),
                        path_encoding(),
                        platform_name(),
                    ],
                )
                .expect("legacy overflow location");
        }
        transaction.commit().expect("legacy rows");

        let resolved = database
            .resolve_media(asset.id())
            .expect("recover overflow")
            .expect("valid tail");
        assert_eq!(resolved.path(), valid_path);
        let retained: i64 = connection
            .query_row(
                "SELECT count(*) FROM media_locations WHERE media_id = ?1",
                [asset.id().as_uuid()],
                |row| row.get(0),
            )
            .expect("retained locations");
        assert_eq!(
            retained,
            i64::try_from(super::MAX_MEDIA_LOCATION_CANDIDATES).expect("cap")
        );
    }

    #[test]
    fn available_location_precedes_a_newer_unavailable_same_size_candidate() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("osg.sqlite3");
        let database = super::super::Database::open(&database_path).expect("database");
        let good_path = directory.path().join("good.mp4");
        let bad_path = directory.path().join("bad.mp4");
        std::fs::write(&good_path, b"media").expect("good fixture");
        std::fs::write(&bad_path, b"other").expect("same-size bad fixture");
        let good_path = std::fs::canonicalize(good_path).expect("canonical good fixture");
        let bad_path = std::fs::canonicalize(bad_path).expect("canonical bad fixture");
        let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
        database
            .remember_media(&asset, &good_path)
            .expect("remember good media");

        let connection = rusqlite::Connection::open(&database_path).expect("seed bad location");
        connection
            .execute(
                "INSERT INTO media_locations(
                   id, media_id, path_bytes, path_encoding, platform, available,
                   last_verified_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
                params![
                    Uuid::now_v7(),
                    asset.id().as_uuid(),
                    encode_path(&bad_path).expect("encoded bad path"),
                    path_encoding(),
                    platform_name(),
                    i64::MAX - 1,
                ],
            )
            .expect("newest unavailable location");

        let plan = super::resolution_plan(&connection, asset.id())
            .expect("resolution plan")
            .expect("known media");
        assert_eq!(plan.candidates.len(), 2);
        assert_eq!(
            plan.candidates[0].path.as_deref(),
            Some(good_path.as_path())
        );
        assert_eq!(plan.candidates[1].path.as_deref(), Some(bad_path.as_path()));
        assert_eq!(
            database
                .resolve_media(asset.id())
                .expect("first resolution")
                .expect("available media")
                .path(),
            good_path
        );
        assert_eq!(
            database
                .resolve_media(asset.id())
                .expect("repeat resolution")
                .expect("available media")
                .path(),
            good_path
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
