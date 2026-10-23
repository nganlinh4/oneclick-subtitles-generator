use osg_application::ProjectSnapshot;
use osg_domain::{
    AssetId, JobId, JobKind, JobSnapshot, MediaAsset, MediaKind, ProjectMetadata, RevisionReason,
};
use rusqlite::params;
use serde_json::Value;
use uuid::Uuid;

mod candidates;
mod crash_recovery;
mod job_claims;
mod locations;
mod project_commit;
mod project_ownership;
mod snapshots;

#[cfg(unix)]
use super::files::snapshot_media_file_with_post_copy;
use super::files::{
    decode_path, digest_media_file_with_post_hash, encode_path, path_encoding, platform_name,
};
use super::{digest_media_file, publish_durable_media, publish_durable_media_candidate};
use crate::storage::{
    ArtifactDraft, ArtifactKind, ArtifactRegistration, ArtifactRetention, ArtifactState,
    CacheCategory, CacheKey, CacheWrite, ContentHash, DatabaseError,
};

fn complete_queued_job(database: &super::super::Database, job: &mut JobSnapshot) {
    let queued_sequence = job.sequence();
    job.start().expect("start completed job");
    database
        .compare_and_swap_job(queued_sequence, job)
        .expect("persist running job");
    let running_sequence = job.sequence();
    job.succeed().expect("complete job");
    database
        .compare_and_swap_job(running_sequence, job)
        .expect("persist completed job");
}

/// Reads the durable lifetime-owner fact directly, so ownership assertions never depend on
/// the same query the resolution path uses.
fn lifetime_owners(database_path: &std::path::Path, media_id: AssetId) -> Vec<Uuid> {
    let connection = rusqlite::Connection::open(database_path).expect("inspect lifetime owners");
    let mut statement = connection
        .prepare("SELECT project_id FROM media_project_owners WHERE media_id = ?1")
        .expect("lifetime owner statement");
    statement
        .query_map([media_id.as_uuid()], |row| row.get::<_, Uuid>(0))
        .expect("lifetime owner rows")
        .map(|row| row.expect("lifetime owner row"))
        .collect()
}

/// Stages media the way an ordinary (non-candidate) import does: a durable managed snapshot
/// plus a remembered native location, with no candidate lease at all.
fn stage_remembered_import(
    database: &super::super::Database,
    path: &std::path::Path,
    fill: u8,
) -> (MediaAsset, Vec<u8>) {
    let bytes = vec![fill; 16 * 1024];
    std::fs::write(path, &bytes).expect("import fixture");
    let asset = MediaAsset::new(
        path.file_name()
            .and_then(std::ffi::OsStr::to_str)
            .expect("fixture name"),
        "mp4",
        u64::try_from(bytes.len()).expect("fixture size"),
        MediaKind::Video,
    )
    .expect("asset");
    database
        .remember_media(&asset, path)
        .expect("ordinary imports are remembered without a candidate lease");
    (asset, bytes)
}

/// Attaches already staged media through a normal project commit and reports the base and
/// attach state versions the frontend would keep.
fn attach_media_to_new_project(
    database: &super::super::Database,
    name: &str,
    asset: &MediaAsset,
) -> (ProjectMetadata, u64, u64) {
    let metadata = ProjectMetadata::new(name).expect("project metadata");
    let base = database.create_project(&metadata).expect("create project");
    let attach = ProjectSnapshot::new(
        metadata.clone(),
        base.state_version(),
        vec![asset.clone()],
        Vec::new(),
    )
    .expect("attach snapshot");
    let attached = database
        .commit_project(
            &attach,
            &RevisionReason::new("attach active media").expect("revision reason"),
        )
        .expect("attach active media");
    (metadata, base.state_version(), attached.state_version)
}

fn make_test_file_writable(path: &std::path::Path) {
    let metadata = std::fs::metadata(path).expect("artifact metadata");
    let mut permissions = metadata.permissions();
    #[cfg(windows)]
    {
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        permissions.set_mode(permissions.mode() | 0o200);
    }
    std::fs::set_permissions(path, permissions).expect("make fixture writable");
}
