use base64::{Engine as _, engine::general_purpose::STANDARD};
use minisign_verify::PublicKey;
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{CommandError, CommandResult};

const UPDATE_SIGNING_PUBLIC_KEY: &str = include_str!("../updater-public-key.txt");
const MAX_RELEASE_NOTES_UTF16_UNITS: usize = 32 * 1024;
const MAX_VERSION_LENGTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateInfo {
    version: String,
    published_at: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateStatus {
    configured: bool,
    current_version: String,
    update: Option<AppUpdateInfo>,
}

#[tauri::command]
pub(crate) async fn app_update_check<R: Runtime>(
    app: AppHandle<R>,
) -> CommandResult<AppUpdateStatus> {
    let current_version = app.package_info().version.to_string();
    if !has_configured_signing_key() {
        return Ok(AppUpdateStatus {
            configured: false,
            current_version,
            update: None,
        });
    }

    let update = app
        .updater()
        .map_err(|_| CommandError::updater_unavailable())?
        .check()
        .await
        .map_err(|_| CommandError::updater_unavailable())?
        .map(|release| {
            if release.version.is_empty() || release.version.len() > MAX_VERSION_LENGTH {
                return Err(CommandError::updater_unavailable());
            }
            Ok(AppUpdateInfo {
                version: release.version,
                published_at: release.date.map(|date| date.to_string()),
                notes: release
                    .body
                    .map(|notes| bounded_text(&notes, MAX_RELEASE_NOTES_UTF16_UNITS)),
            })
        })
        .transpose()?;

    Ok(AppUpdateStatus {
        configured: true,
        current_version,
        update,
    })
}

pub(crate) fn updater_plugin<R: Runtime>()
-> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    let public_key = if has_configured_signing_key() {
        UPDATE_SIGNING_PUBLIC_KEY.trim()
    } else {
        ""
    };
    tauri_plugin_updater::Builder::new()
        .pubkey(public_key)
        .build()
}

fn has_configured_signing_key() -> bool {
    is_valid_signing_key(UPDATE_SIGNING_PUBLIC_KEY.trim())
}

fn is_valid_signing_key(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 {
        return false;
    }
    let Ok(decoded) = STANDARD.decode(value) else {
        return false;
    };
    let Ok(envelope) = std::str::from_utf8(&decoded) else {
        return false;
    };
    let mut lines = envelope.lines();
    matches!(lines.next(), Some(comment) if comment.starts_with("untrusted comment:"))
        && lines.next().is_some()
        && lines.next().is_none()
        && PublicKey::decode(envelope).is_ok()
}

fn bounded_text(value: &str, maximum_utf16_units: usize) -> String {
    let mut used = 0;
    value
        .chars()
        .take_while(|character| {
            let next = used + character.len_utf16();
            if next > maximum_utf16_units {
                return false;
            }
            used = next;
            true
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::{MAX_RELEASE_NOTES_UTF16_UNITS, bounded_text, is_valid_signing_key};

    #[test]
    fn signing_key_validation_is_strict_and_never_accepts_the_placeholder() {
        assert!(!is_valid_signing_key(""));
        assert!(!is_valid_signing_key("UNCONFIGURED"));
        assert!(!is_valid_signing_key(&"A".repeat(44)));
        assert!(!is_valid_signing_key(
            &STANDARD.encode("not a minisign key")
        ));
        let envelope = concat!(
            "untrusted comment: minisign public key 17620F91860D0F62\n",
            "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n",
        );
        assert!(is_valid_signing_key(&STANDARD.encode(envelope)));
        assert!(!is_valid_signing_key(
            &STANDARD.encode(format!("{envelope}extra\n"))
        ));
    }

    #[test]
    fn release_notes_match_the_frontend_utf16_bound_without_splitting_unicode() {
        let notes = format!(
            "{}🦀overflow",
            "a".repeat(MAX_RELEASE_NOTES_UTF16_UNITS - 2)
        );
        let bounded = bounded_text(&notes, MAX_RELEASE_NOTES_UTF16_UNITS);

        assert_eq!(
            bounded.encode_utf16().count(),
            MAX_RELEASE_NOTES_UTF16_UNITS
        );
        assert!(bounded.ends_with('🦀'));
        assert!(!bounded.contains("overflow"));
    }
}
