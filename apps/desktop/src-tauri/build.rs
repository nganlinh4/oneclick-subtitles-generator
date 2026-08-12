const COMMANDS: &[&str] = &[
    "app_health",
    "get_session_snapshot",
    "select_media",
    "clear_media",
    "open_media_asset",
    "media_drop_subscribe",
    "media_drop_unsubscribe",
    "media_drop_discard",
    "media_drop_claim",
    "setting_get",
    "setting_set",
    "settings_set_many",
    "setting_delete",
    "settings_clear",
    "cache_info",
    "cache_clear",
    "cache_prune_expired",
    "download_status",
    "download_inspect",
    "download_start",
    "download_cancel",
    "project_create",
    "project_load",
    "project_history_status",
    "project_track_history_status",
    "project_commit",
    "project_track_commit",
    "project_undo",
    "project_redo",
    "project_track_undo",
    "project_track_redo",
    "jobs_list",
    "job_get",
    "job_cancel",
    "credential_set",
    "credential_upsert",
    "credential_delete",
    "credential_status",
    "genius_lyrics",
    "youtube_search",
    "youtube_video_details",
    "youtube_thumbnail",
    "youtube_oauth_authorize",
    "youtube_oauth_cancel",
    "youtube_oauth_status",
    "youtube_oauth_clear",
    "legacy_import_select",
    "legacy_import_status",
    "live_music_start",
    "live_music_update",
    "live_music_control",
    "live_music_close",
    "media_blob_import",
    "media_blob_release",
    "media_export_start",
    "gemini_start",
    "image_blob_import",
    "image_blob_release",
    "gemini_image_start",
    "native_tools_catalog",
    "native_tools_status",
    "native_tool_install",
    "native_tool_remove",
    "native_tool_cancel",
    "media_pipeline_inspect",
    "media_pipeline_start",
    "media_pipeline_cancel",
    "render_runtime_status",
    "render_start",
    "render_result",
    "render_playback_release",
    "render_package_status",
    "render_package_install",
    "render_package_remove",
    "asr_status",
    "asr_start",
    "engine_packages_status",
    "engine_package_install",
    "engine_package_remove",
    "engine_runtime_start",
    "engine_runtime_stop",
    "speech_packages_status",
    "speech_package_install",
    "speech_package_remove",
    "speech_status",
    "speech_probe",
    "speech_runtime_stop",
    "speech_reference_select",
    "speech_reference_extract",
    "speech_reference_import",
    "speech_start",
    "speech_voice_conversion_start",
    "speech_artifact_edit",
    "speech_artifact_export",
    "speech_job_results",
    "speech_alignment_start",
    "speech_alignment_result",
    "speech_artifact_resolve",
    "speech_playback_release",
    "app_update_check",
    "app_update_install",
    "app_update_cancel",
    "open_external_link",
    "voice_samples_status",
    "voice_samples_install",
    "voice_samples_cancel",
    "voice_sample_resolve",
    "voice_samples_remove",
];

fn main() {
    verify_ci_updater_fixture_scope();
    verify_managed_delivery_contract();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to generate the Tauri application manifest");
}

fn verify_ci_updater_fixture_scope() {
    if std::env::var_os("CARGO_FEATURE_CI_UPDATER_FIXTURE").is_none()
        || std::env::var("PROFILE").as_deref() != Ok("release")
    {
        return;
    }
    assert_eq!(
        std::env::var("GITHUB_ACTIONS").as_deref(),
        Ok("true"),
        "the signed updater fixture may be compiled only on GitHub Actions"
    );
    assert_eq!(
        std::env::var("OSG_ENABLE_SIGNED_UPDATER_FIXTURE").as_deref(),
        Ok("1"),
        "the signed updater fixture requires an explicit isolated-workflow opt-in"
    );
}

fn verify_managed_delivery_contract() {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let watched = [
        "delivery/managed-delivery.checkpoint.json",
        "scripts/check-managed-delivery-contract.py",
        "scripts/apply-managed-delivery-catalog.py",
        "scripts/build-managed-runtime-delivery.py",
        "scripts/build-provider-speech-runtime.py",
        "scripts/compose-managed-deliveries.py",
        "scripts/build-voice-samples-delivery.py",
        "scripts/build-ui-font-delivery.py",
        "scripts/generate-remotion-delivery-manifest.mjs",
        "scripts/generate-remotion-runtime-manifest.mjs",
        "crates/osg-native-tools/delivery/native-tools.delivery.json",
        "crates/osg-native-tools/delivery/native-tools.upstreams.lock.json",
        "crates/osg-engine-packages/delivery/engine-packages.delivery.json",
        "crates/osg-engine-packages/delivery/voice-samples.delivery.json",
        "crates/osg-engine-packages/delivery/ui-fonts.delivery.json",
        "crates/osg-engine-packages/delivery/windows-managed-runtime-notices.json",
        "crates/osg-speech/delivery/speech-packages.delivery.json",
        "crates/osg-speech/delivery/provider-runtime-windows.lock.json",
        "crates/osg-speech/delivery/speech-upstreams.lock.json",
        "video-renderer/delivery/remotion-runtime.delivery.json",
        "video-renderer/native.tsconfig.json",
        "video-renderer/package.json",
        "video-renderer/remotion.config.ts",
        "video-renderer/scripts/build-native-bundle.mjs",
        "video-renderer/worker/osg_render_worker.mjs",
    ];
    for relative in watched {
        println!(
            "cargo:rerun-if-changed={}",
            repository.join(relative).display()
        );
    }
    watch_tree(&repository.join("video-renderer/src"));

    let interpreter = if cfg!(windows) { "python" } else { "python3" };
    let result = Command::new(interpreter)
        .args(["-I", "-B", "scripts/check-managed-delivery-contract.py"])
        .current_dir(&repository)
        .output()
        .unwrap_or_else(|_| {
            panic!("pinned Python is required to verify the managed-delivery contract")
        });
    if !result.status.success() {
        let detail = String::from_utf8_lossy(&result.stderr);
        panic!("managed-delivery contract rejected the desktop build: {detail}");
    }
}

fn watch_tree(root: &Path) {
    let mut pending = vec![PathBuf::from(root)];
    while let Some(directory) = pending.pop() {
        let mut entries = std::fs::read_dir(&directory)
            .unwrap_or_else(|_| panic!("managed-delivery source tree is missing"))
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_else(|_| panic!("managed-delivery source tree is unreadable"));
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            let file_type = entry
                .file_type()
                .unwrap_or_else(|_| panic!("managed-delivery source entry is unreadable"));
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file() {
                println!("cargo:rerun-if-changed={}", path.display());
            } else {
                panic!("managed-delivery source tree contains an unsupported entry");
            }
        }
    }
}
use std::path::{Path, PathBuf};
use std::process::Command;
