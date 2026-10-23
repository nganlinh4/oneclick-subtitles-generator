use std::fs;
use std::path::Path;
use std::time::Duration;

use osg_domain::ProjectId;
use osg_media_server::MediaServer;
use tempfile::tempdir;

use super::commands::{import_registered_image, local_image_mime_type, register_local_reference};
use super::export::{
    ReferenceImageFormat, canonical_export_name, prepare_reference_image_export,
    write_reference_image_export,
};
use super::requests::{ImageBlobPlaybackImportRequest, ImageReferenceExportRequest};
use super::{IMAGE_TTL, ImageBlobStore, MAX_ACTIVE_IMAGES};

fn png() -> Vec<u8> {
    b"\x89PNG\r\n\x1a\nreference".to_vec()
}

fn media_server() -> MediaServer {
    MediaServer::start(["http://127.0.0.1:3030".to_owned()]).expect("media server")
}

#[test]
fn imports_resolves_and_releases_only_an_opaque_id() {
    let store = ImageBlobStore::default();
    let project_id = ProjectId::new();
    let descriptor = store
        .import(project_id, "image/png", &png())
        .expect("import");
    assert_eq!(descriptor.mime_type, "image/png");
    assert_eq!(descriptor.size_bytes, png().len());
    assert_eq!(
        store
            .resolve(descriptor.asset_id, project_id)
            .expect("resolve")
            .expect("image")
            .mime_type(),
        "image/png"
    );
    assert!(
        store
            .resolve(descriptor.asset_id, ProjectId::new())
            .expect("wrong project")
            .is_none()
    );
    assert!(store.release(descriptor.asset_id).expect("release"));
    assert!(!store.release(descriptor.asset_id).expect("idempotent"));
    assert!(!format!("{store:?}").contains("reference"));
}

#[test]
fn rejects_signature_mismatch_and_expires_old_entries() {
    let store = ImageBlobStore::default();
    let project_id = ProjectId::new();
    assert!(store.import(project_id, "image/png", b"not png").is_err());
    let descriptor = store
        .import(project_id, "image/png", &png())
        .expect("import");
    {
        let mut registry = store.0.lock().expect("registry");
        registry
            .entries
            .get_mut(&descriptor.asset_id)
            .expect("entry")
            .created_at -= IMAGE_TTL + Duration::from_secs(1);
    }
    assert!(
        store
            .resolve(descriptor.asset_id, project_id)
            .expect("purge")
            .is_none()
    );
}

#[test]
fn local_picker_formats_and_playback_ownership_are_closed_and_project_bound() {
    assert_eq!(
        local_image_mime_type(Path::new("cover.JPG")),
        Some("image/jpeg")
    );
    assert_eq!(
        local_image_mime_type(Path::new("cover.webp")),
        Some("image/webp")
    );
    assert_eq!(local_image_mime_type(Path::new("cover.gif")), None);
    assert_eq!(local_image_mime_type(Path::new("cover.png.exe")), None);

    let directory = tempdir().expect("tempdir");
    let path = directory.path().join("cover.png");
    fs::write(&path, png()).expect("fixture");
    let server = media_server();
    let project_a = ProjectId::new();
    let project_b = ProjectId::new();
    let playback = register_local_reference(&server, &path, project_a).expect("register");
    assert!(
        server
            .copy_registered_image_for_owner(playback.id, project_b.into_uuid(), png().len(),)
            .is_err()
    );
    assert!(
        server
            .unregister_owned_image(playback.id, project_b.into_uuid())
            .is_err()
    );
    assert!(
        server
            .unregister_owned_image(playback.id, project_a.into_uuid())
            .expect("exact release")
    );
}

#[test]
fn provider_import_first_binds_reuses_same_project_and_rejects_cross_project() {
    let server = media_server();
    let store = ImageBlobStore::default();
    let playback = server
        .register_image("image/png", png())
        .expect("provider image");
    let project_a = ProjectId::new();
    let project_b = ProjectId::new();
    let first = import_registered_image(
        &server,
        &store,
        &ImageBlobPlaybackImportRequest {
            playback_id: playback.id,
            project_id: project_a,
        },
    )
    .expect("first import");
    let second = import_registered_image(
        &server,
        &store,
        &ImageBlobPlaybackImportRequest {
            playback_id: playback.id,
            project_id: project_a,
        },
    )
    .expect("same project reuse");
    assert!(
        import_registered_image(
            &server,
            &store,
            &ImageBlobPlaybackImportRequest {
                playback_id: playback.id,
                project_id: project_b,
            },
        )
        .is_err()
    );
    assert!(store.release(first.asset_id).expect("first release"));
    assert!(store.release(second.asset_id).expect("second release"));
}

#[test]
fn failed_import_capacity_rolls_back_only_the_new_provider_binding() {
    let server = media_server();
    let store = ImageBlobStore::default();
    let project_a = ProjectId::new();
    for _ in 0..MAX_ACTIVE_IMAGES {
        store
            .import(project_a, "image/png", &png())
            .expect("fill temporary store");
    }
    let playback = server
        .register_image("image/png", png())
        .expect("provider image");
    assert!(
        import_registered_image(
            &server,
            &store,
            &ImageBlobPlaybackImportRequest {
                playback_id: playback.id,
                project_id: project_a,
            },
        )
        .is_err()
    );
    let project_b = ProjectId::new();
    let image = server
        .copy_registered_image_for_owner(playback.id, project_b.into_uuid(), png().len())
        .expect("binding rollback")
        .expect("provider remains registered");
    image.commit().expect("new owner commits");
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the test exercises cancellation and preparation rollback as one ownership lifecycle"
)]
fn export_cancel_and_preparation_failure_rollback_pending_provider_ownership() {
    let server = media_server();
    let project_a = ProjectId::new();
    let project_b = ProjectId::new();
    let playback = server
        .register_image("image/png", png())
        .expect("provider image");
    let cancelled = prepare_reference_image_export(
        &server,
        &ImageReferenceExportRequest {
            project_id: project_a,
            playback_id: playback.id,
            suggested_name: "album-art.webp".to_owned(),
        },
    )
    .expect("prepare export");
    assert_eq!(cancelled.suggested_name, "album-art.png");
    drop(cancelled);

    let committed = prepare_reference_image_export(
        &server,
        &ImageReferenceExportRequest {
            project_id: project_b,
            playback_id: playback.id,
            suggested_name: "album-art.jpg".to_owned(),
        },
    )
    .expect("cancel rolled binding back");
    let directory = tempdir().expect("tempdir");
    let authority_directory = tempdir().expect("authority tempdir");
    let authority =
        osg_runtime_staging::RuntimeStagingAuthority::prepare(authority_directory.path()).unwrap();
    let destination = directory.path().join("album-art.png");
    write_reference_image_export(&authority, committed.image.bytes(), &destination)
        .expect("write export");
    committed.image.commit().expect("commit owner");
    assert_eq!(fs::read(destination).expect("export bytes"), png());
    let repeated = prepare_reference_image_export(
        &server,
        &ImageReferenceExportRequest {
            project_id: project_b,
            playback_id: playback.id,
            suggested_name: "second.png".to_owned(),
        },
    )
    .expect("same-project export reuse");
    drop(repeated);
    assert!(
        prepare_reference_image_export(
            &server,
            &ImageReferenceExportRequest {
                project_id: project_a,
                playback_id: playback.id,
                suggested_name: "cross-project.png".to_owned(),
            },
        )
        .is_err()
    );

    let gif = server
        .register_image("image/gif", b"GIF89a-private".to_vec())
        .expect("gif capability");
    assert!(
        prepare_reference_image_export(
            &server,
            &ImageReferenceExportRequest {
                project_id: project_a,
                playback_id: gif.id,
                suggested_name: "album-art.png".to_owned(),
            },
        )
        .is_err()
    );
    let recovered = server
        .copy_registered_image_for_owner(gif.id, project_b.into_uuid(), 64)
        .expect("failed prep rolls back")
        .expect("gif remains registered");
    recovered.commit().expect("new owner after failed prep");

    let failed_write = server
        .register_image("image/png", png())
        .expect("write-failure capability");
    let failed_plan = prepare_reference_image_export(
        &server,
        &ImageReferenceExportRequest {
            project_id: project_a,
            playback_id: failed_write.id,
            suggested_name: "failed.png".to_owned(),
        },
    )
    .expect("write-failure plan");
    assert!(
        write_reference_image_export(
            &authority,
            failed_plan.image.bytes(),
            Path::new("relative.png")
        )
        .is_err()
    );
    drop(failed_plan);
    let recovered = server
        .copy_registered_image_for_owner(failed_write.id, project_b.into_uuid(), png().len())
        .expect("failed write rolls back")
        .expect("write-failure capability remains");
    recovered.commit().expect("new owner after failed write");

    assert_eq!(
        canonical_export_name("cover.jpeg", ReferenceImageFormat::Webp).as_deref(),
        Some("cover.webp")
    );
    assert!(canonical_export_name("../cover.png", ReferenceImageFormat::Png).is_none());
}
