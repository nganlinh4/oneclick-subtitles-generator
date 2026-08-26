use std::path::PathBuf;

#[cfg(any(feature = "e2e-automation", test))]
use std::ffi::OsStr;
#[cfg(any(feature = "e2e-automation", test))]
use std::path::Path;
#[cfg(feature = "e2e-automation")]
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, WebviewWindow};

use crate::error::{CommandError, CommandResult};

#[cfg(not(feature = "e2e-automation"))]
use tauri_plugin_dialog::DialogExt;

#[cfg(any(feature = "e2e-automation", test))]
fn automation_dialog_refused() -> CommandError {
    CommandError::invalid_input("The automation build refused an unstaged native file dialog.")
}

#[cfg(feature = "e2e-automation")]
static STAGED_MEDIA_SELECTION_INDEX: AtomicUsize = AtomicUsize::new(0);

#[cfg(any(feature = "e2e-automation", test))]
const MAX_STAGED_MEDIA_SELECTIONS: usize = 8;

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

#[cfg(any(feature = "e2e-automation", test))]
fn validate_staged_media_selection(root: &Path, selection: &Path) -> CommandResult<PathBuf> {
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

#[cfg(any(feature = "e2e-automation", test))]
fn parse_staged_media_sequence(raw: &str) -> CommandResult<Vec<PathBuf>> {
    let selections: Vec<String> =
        serde_json::from_str(raw).map_err(|_| automation_dialog_refused())?;
    if selections.is_empty()
        || selections.len() > MAX_STAGED_MEDIA_SELECTIONS
        || selections.iter().any(String::is_empty)
    {
        return Err(automation_dialog_refused());
    }
    Ok(selections.into_iter().map(PathBuf::from).collect())
}

#[cfg(feature = "e2e-automation")]
fn staged_media_selection() -> CommandResult<PathBuf> {
    let root = std::env::var_os("OSG_E2E_FIXTURE_ROOT")
        .map(PathBuf::from)
        .ok_or_else(automation_dialog_refused)?;
    let selection = if let Some(raw) = std::env::var_os("OSG_E2E_MEDIA_SELECTION_SEQUENCE") {
        let raw = raw.to_str().ok_or_else(automation_dialog_refused)?;
        let selections = parse_staged_media_sequence(raw)?;
        let index = STAGED_MEDIA_SELECTION_INDEX.fetch_add(1, Ordering::SeqCst);
        selections
            .get(index)
            .cloned()
            .ok_or_else(automation_dialog_refused)?
    } else {
        std::env::var_os("OSG_E2E_MEDIA_SELECTION")
            .map(PathBuf::from)
            .ok_or_else(automation_dialog_refused)?
    };
    validate_staged_media_selection(&root, &selection)
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

    use super::{
        MAX_STAGED_MEDIA_SELECTIONS, parse_staged_media_sequence, validate_staged_media_selection,
        validate_staged_save_destination,
    };

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

    #[test]
    fn staged_media_sequence_is_bounded_and_every_selection_stays_inside_the_root() {
        let root = tempfile::tempdir().expect("root");
        let first = root.path().join("first.mp4");
        let second = root.path().join("second.mp4");
        std::fs::write(&first, b"first").expect("first");
        std::fs::write(&second, b"second").expect("second");

        let raw = serde_json::to_string(&vec![&first, &second]).expect("sequence json");
        let parsed = parse_staged_media_sequence(&raw).expect("valid sequence");
        assert_eq!(parsed, vec![first.clone(), second.clone()]);
        assert_eq!(
            validate_staged_media_selection(root.path(), &parsed[0]).expect("inside root"),
            first.canonicalize().expect("canonical first")
        );

        let outside = tempfile::NamedTempFile::new().expect("outside");
        assert!(validate_staged_media_selection(root.path(), outside.path()).is_err());
        assert!(parse_staged_media_sequence("[]").is_err());
        assert!(parse_staged_media_sequence("not-json").is_err());
        assert!(
            parse_staged_media_sequence(
                &serde_json::to_string(&vec!["x"; MAX_STAGED_MEDIA_SELECTIONS + 1])
                    .expect("long sequence")
            )
            .is_err()
        );
    }
}
