//! The user-facing repair action for the managed subtitle font.
//!
//! A refusal that says `retryable` and offers no way to retry is a worse interface than one that
//! says nothing, so the flag and this command ship together. Everything the repair needs -- the
//! store root and the shipped bytes -- is resolved once at startup and held here, because a command
//! must never accept a path from the `WebView`.

use std::path::PathBuf;
use std::sync::Arc;

use crate::font_readiness::{FontReadiness, FontReadinessRecord, FontRefusal};
use crate::ui_fonts::{PreparedUiFont, UiFontRuntime};

/// Where a repair may install from. Resolved by native at startup and never supplied by a caller.
#[derive(Debug)]
pub(crate) struct FontRepairContext {
    root: PathBuf,
    bundle: Option<PathBuf>,
}

impl FontRepairContext {
    pub(crate) const fn new(root: PathBuf, bundle: Option<PathBuf>) -> Self {
        Self { root, bundle }
    }
}

/// Retry the managed font installation and report the state the attempt started from.
///
/// Returns immediately with the `Repairing` record rather than waiting for the outcome: the caller
/// is an interface that must stay responsive, and the result arrives through the same late-repair
/// path a first attempt uses. Repeated invocations are harmless -- each publishes `Repairing` and
/// the last completion wins, which is correct because they all install the identical pinned bytes.
// The parameters are by value because Tauri's `CommandArg` requires it: a command cannot take
// `&AppHandle` or a borrowed `State`. `app` is genuinely consumed by the closure below; the two
// states are read and released, which is the shape every command in this application has.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub(crate) fn font_readiness_retry(
    app: tauri::AppHandle,
    context: tauri::State<'_, FontRepairContext>,
    readiness: tauri::State<'_, Arc<FontReadiness>>,
) -> Result<FontReadinessRecord, String> {
    let authority = Arc::clone(&readiness);
    let publish = move |outcome: Result<PreparedUiFont, FontRefusal>| {
        crate::late_font_ready(&app, &authority, outcome);
    };

    UiFontRuntime::repair(&context.root, context.bundle.clone(), &readiness, publish)
        .map_err(|_| "the font repair could not be started".to_owned())?;
    Ok(readiness.snapshot())
}
