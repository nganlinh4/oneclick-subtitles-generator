use std::path::PathBuf;

#[cfg(any(feature = "e2e-automation", test))]
use std::ffi::OsStr;
#[cfg(any(feature = "e2e-automation", test))]
use std::path::Path;

use tauri::{AppHandle, WebviewWindow};

use crate::error::{CommandError, CommandResult};

#[cfg(not(feature = "e2e-automation"))]
use tauri_plugin_dialog::DialogExt;

#[cfg(any(feature = "e2e-automation", test))]
fn automation_dialog_refused() -> CommandError {
    CommandError::invalid_input("The automation build refused an unstaged native file dialog.")
}

#[cfg(feature = "e2e-automation")]
fn staged_save_destination(suggested_name: &str) -> CommandResult<PathBuf> {
    let root = std::env::var_os("OSG_E2E_FIXTURE_ROOT")
        .map(PathBuf::from)
        .ok_or_else(automation_dialog_refused)?;
    let directory = std::env::var_os("OSG_E2E_MEDIA_DESTINATION")
        .map(PathBuf::from)
        .ok_or_else(automation_dialog_refused)?;
    validate_staged_save_destination(&root, &directory, suggested_name)
}

#[cfg(any(feature = "e2e-automation", test))]
fn validate_staged_save_destination(
    root: &Path,
    directory: &Path,
    suggested_name: &str,
) -> CommandResult<PathBuf> {
    if suggested_name.is_empty()
        || Path::new(suggested_name).file_name() != Some(OsStr::new(suggested_name))
    {
        return Err(automation_dialog_refused());
    }
    let root = root
        .canonicalize()
        .map_err(|_| automation_dialog_refused())?;
    let directory = directory
        .canonicalize()
        .map_err(|_| automation_dialog_refused())?;
    if !directory.starts_with(&root) || !directory.is_dir() {
        return Err(automation_dialog_refused());
    }
    let destination = directory.join(suggested_name);
    if destination.parent() != Some(directory.as_path()) || destination.exists() {
        return Err(automation_dialog_refused());
    }
    Ok(destination)
}

/// Selects an export destination.
///
/// The automation build has no native-dialog fallback: missing, malformed, out-of-root, or already
/// occupied staging is a typed refusal. Consequently an autonomous journey cannot open File
/// Explorer even when its harness setup is wrong.
#[cfg(feature = "e2e-automation")]
pub(crate) fn save_file(
    _app: &AppHandle,
    _title: &str,
    suggested_name: &str,
    _filter_label: &str,
    _extensions: &[&str],
) -> CommandResult<Option<PathBuf>> {
    staged_save_destination(suggested_name).map(Some)
}

#[cfg(not(feature = "e2e-automation"))]
pub(crate) fn save_file(
    app: &AppHandle,
    title: &str,
    suggested_name: &str,
    filter_label: &str,
    extensions: &[&str],
) -> CommandResult<Option<PathBuf>> {
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(suggested_name)
        .add_filter(filter_label, extensions)
        .blocking_save_file()
        .map(|selected| {
            selected
                .into_path()
                .map_err(|_| CommandError::media_export_unsafe())
        })
        .transpose()
}

#[cfg(feature = "e2e-automation")]
fn staged_media_selection() -> CommandResult<PathBuf> {
    let root = std::env::var_os("OSG_E2E_FIXTURE_ROOT")
        .map(PathBuf::from)
        .ok_or_else(automation_dialog_refused)?;
    let selection = std::env::var_os("OSG_E2E_MEDIA_SELECTION")
        .map(PathBuf::from)
        .ok_or_else(automation_dialog_refused)?;
    let root = root
        .canonicalize()
        .map_err(|_| automation_dialog_refused())?;
    let selection = selection
        .canonicalize()
        .map_err(|_| automation_dialog_refused())?;
    if !selection.starts_with(root) || !selection.is_file() {
        return Err(automation_dialog_refused());
    }
    Ok(selection)
}

#[cfg(feature = "e2e-automation")]
#[allow(
    clippy::unused_async,
    reason = "the automation and production picker implementations intentionally share one async call contract"
)]
pub(crate) async fn pick_file_with_window(
    _window: WebviewWindow,
    _title: &str,
    _filter_label: &str,
    _extensions: &[&str],
) -> CommandResult<Option<PathBuf>> {
    staged_media_selection().map(Some)
}

#[cfg(not(feature = "e2e-automation"))]
pub(crate) async fn pick_file_with_window(
    window: WebviewWindow,
    title: &str,
    filter_label: &str,
    extensions: &[&str],
) -> CommandResult<Option<PathBuf>> {
    let dialog = rfd::FileDialog::new()
        .set_parent(&window)
        .set_title(title)
        .add_filter(filter_label, extensions);
    tauri::async_runtime::spawn_blocking(move || dialog.pick_file())
        .await
        .map_err(|_| CommandError::internal("the file picker task stopped unexpectedly"))
}

#[cfg(feature = "e2e-automation")]
pub(crate) fn pick_file(_app: &AppHandle) -> CommandResult<Option<PathBuf>> {
    Err(automation_dialog_refused())
}

#[cfg(not(feature = "e2e-automation"))]
pub(crate) fn pick_file(app: &AppHandle) -> CommandResult<Option<PathBuf>> {
    app.dialog()
        .file()
        .blocking_pick_file()
        .map(|selected| {
            selected
                .into_path()
                .map_err(|_| CommandError::invalid_path("The selected file is unavailable."))
        })
        .transpose()
}

#[cfg(feature = "e2e-automation")]
pub(crate) fn pick_folder(_app: &AppHandle, _title: &str) -> CommandResult<Option<PathBuf>> {
    Err(automation_dialog_refused())
}

#[cfg(not(feature = "e2e-automation"))]
pub(crate) fn pick_folder(app: &AppHandle, title: &str) -> CommandResult<Option<PathBuf>> {
    app.dialog()
        .file()
        .set_title(title)
        .blocking_pick_folder()
        .map(|selected| {
            selected
                .into_path()
                .map_err(|_| CommandError::legacy_import_invalid())
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::validate_staged_save_destination;

    fn assert_no_dialog_bypass(directory: &Path) {
        for entry in std::fs::read_dir(directory).expect("read source directory") {
            let path = entry.expect("source entry").path();
            if path.is_dir() {
                assert_no_dialog_bypass(&path);
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("rs")
                || path.file_name().and_then(|value| value.to_str()) == Some("dialog_paths.rs")
            {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("read Rust source");
            for forbidden in [
                "rfd::FileDialog",
                ".blocking_save_file(",
                ".blocking_pick_file(",
                ".blocking_pick_folder(",
            ] {
                assert!(
                    !source.contains(forbidden),
                    "{} bypasses the automation-safe dialog boundary with {forbidden}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn every_native_dialog_is_centralized_behind_the_automation_cfg() {
        assert_no_dialog_bypass(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").as_path());
    }

    #[test]
    fn staged_save_is_bounded_and_never_overwrites() {
        let root = tempfile::tempdir().expect("root");
        let output = root.path().join("output");
        std::fs::create_dir(&output).expect("output");
        let destination = validate_staged_save_destination(root.path(), &output, "voice.m4a")
            .expect("valid staged destination");
        assert_eq!(
            destination,
            output
                .canonicalize()
                .expect("canonical output")
                .join("voice.m4a")
        );

        std::fs::write(&destination, b"occupied").expect("occupy destination");
        assert!(validate_staged_save_destination(root.path(), &output, "voice.m4a").is_err());
        assert!(validate_staged_save_destination(root.path(), &output, "../voice.m4a").is_err());

        let outside = tempfile::tempdir().expect("outside");
        assert!(
            validate_staged_save_destination(root.path(), outside.path(), "voice.m4a").is_err()
        );
    }
}
