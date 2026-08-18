#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Either channel is a real packaged build; both carry `tauri/custom-protocol`. What is refused is a
// release binary built with neither, which silently keeps the development URL.
#[cfg(all(
    not(debug_assertions),
    not(feature = "production"),
    not(feature = "unsigned-local-build")
))]
compile_error!(
    "release executables must be built with `npm run tauri:build` (or the `unsigned-local-build` channel); plain `cargo build --release` retains the development URL"
);

fn main() {
    osg_desktop_lib::run();
}
