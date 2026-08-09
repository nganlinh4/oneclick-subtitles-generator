mod commands;
mod error;
mod state;

use commands::{app_health, get_session_snapshot, select_media, select_subtitle_file};
use state::DesktopState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            app_health,
            get_session_snapshot,
            select_media,
            select_subtitle_file,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri runtime failed");
}
