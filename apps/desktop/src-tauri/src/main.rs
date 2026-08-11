#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(not(debug_assertions), not(feature = "production")))]
compile_error!(
    "release executables must be built with `npm run tauri:build`; plain `cargo build --release` retains the development URL"
);

fn main() {
    osg_desktop_lib::run();
}
