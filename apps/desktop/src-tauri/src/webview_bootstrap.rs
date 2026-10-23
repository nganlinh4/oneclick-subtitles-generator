//! `WebView` initialization scripts: the durable settings mirror and UI font installation.

use std::collections::BTreeMap;

use osg_infrastructure::storage::is_secret_setting_key;
use serde_json::Value;

use crate::font_readiness;
use crate::legacy_import::{is_project_scoped_setting_key, is_transient_setting_key};

// SQLite is the durable preference authority. The WebView mirrors it so legacy readers can keep
// using localStorage while they are migrated, but a crash between the native commit and that mirror
// update must not resurrect the stale browser value on the next launch.
//
// The marker remains only so upgraded installations can discard the old one-shot bootstrap state.
// Both bookkeeping keys are WebView-only because the `current_` prefix is excluded from settings.
const WEBVIEW_SETTINGS_BOOTSTRAP_MARKER: &str = "current_settings_bootstrap_v1";
const WEBVIEW_NATIVE_SETTINGS_KEY_INDEX: &str = "current_native_settings_keys_v1";

pub(crate) fn settings_initialization_script(
    settings: &BTreeMap<String, Value>,
) -> Result<String, serde_json::Error> {
    let safe_settings: BTreeMap<&str, &Value> = settings
        .iter()
        .filter(|(key, _)| is_webview_bootstrap_setting_key(key))
        .map(|(key, value)| (key.as_str(), value))
        .collect();
    let serialized = serde_json::to_string(&safe_settings)?;
    let string_literal = serde_json::to_string(&serialized)?;
    let marker_literal = serde_json::to_string(WEBVIEW_SETTINGS_BOOTSTRAP_MARKER)?;
    let index_literal = serde_json::to_string(WEBVIEW_NATIVE_SETTINGS_KEY_INDEX)?;
    Ok(format!(
        "(() => {{ localStorage.removeItem('original_subtitles_map'); const marker = {marker_literal}; const indexKey = {index_literal}; const values = JSON.parse({string_literal}); let previousKeys = []; try {{ const parsed = JSON.parse(localStorage.getItem(indexKey) || '[]'); if (Array.isArray(parsed)) previousKeys = parsed.filter(key => typeof key === 'string' && /^[A-Za-z0-9._:-]{{1,128}}$/.test(key) && !key.startsWith('current_')); }} catch (_error) {{ previousKeys = []; }} const currentKeys = Object.keys(values); const currentKeySet = new Set(currentKeys); for (const key of previousKeys) {{ if (!currentKeySet.has(key)) localStorage.removeItem(key); }} for (const [key, value] of Object.entries(values)) {{ const stored = typeof value === 'string' ? value : JSON.stringify(value); if (stored !== undefined) localStorage.setItem(key, stored); }} localStorage.setItem(indexKey, JSON.stringify(currentKeys)); localStorage.removeItem(marker); }})();"
    ))
}

/// JavaScript that installs the managed font stylesheet, idempotently.
///
/// Shared by the first-document bootstrap and by a late repair that has to reach a window already
/// on screen. One implementation on purpose: two would drift, and the difference between them would
/// be invisible until a font failed to appear in exactly one of the two paths.
pub(crate) fn ui_font_install_script(css: &str) -> String {
    let css_literal = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".to_owned());
    format!(
        "(() => {{ const css = {css_literal}; const install = () => {{ if (document.getElementById('osg-managed-ui-font')) return true; const target = document.head || document.documentElement; if (!target) return false; const style = document.createElement('style'); style.id = 'osg-managed-ui-font'; style.textContent = css; target.appendChild(style); return true; }}; if (!install()) {{ const retry = () => {{ if (install()) {{ document.removeEventListener('readystatechange', retry); document.removeEventListener('DOMContentLoaded', retry); }} }}; document.addEventListener('readystatechange', retry); document.addEventListener('DOMContentLoaded', retry); }} }})();"
    )
}

pub(crate) fn window_initialization_script(
    settings: &BTreeMap<String, Value>,
    ui_font_css: Option<&str>,
    readiness: &font_readiness::FontReadinessRecord,
) -> Result<String, serde_json::Error> {
    let settings_script = settings_initialization_script(settings)?;
    // A mutable property, not a frozen one. Readiness changes: a repair that finishes after startup
    // publishes a new record, and a value defined with `writable: false` could never carry it. That
    // is precisely how a font that finished installing seconds late stayed unavailable all session.
    let record_literal = serde_json::to_string(readiness)?;
    let readiness_script = format!("window.__OSG_FONT_READINESS__ = {record_literal};");
    let install_script = ui_font_css.map(ui_font_install_script).unwrap_or_default();
    Ok(format!(
        "{install_script}{readiness_script}{settings_script}"
    ))
}

pub(crate) fn is_safe_setting_key(key: &str) -> bool {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return false;
    }
    !(is_project_scoped_setting_key(key)
        || is_transient_setting_key(key)
        || is_secret_setting_key(key))
}

fn is_native_owned_setting_key(key: &str) -> bool {
    matches!(
        key,
        "gemini.keySelection.v1" | "project.subtitleCacheIndex.v1"
    ) || key.starts_with("project.legacyAux.v1.")
}

pub(crate) fn is_webview_bootstrap_setting_key(key: &str) -> bool {
    is_safe_setting_key(key) && !is_native_owned_setting_key(key)
}
