const COMMANDS: &[&str] = &[
    "app_health",
    "get_session_snapshot",
    "select_media",
    "select_subtitle_file",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to generate the Tauri application manifest");
}
