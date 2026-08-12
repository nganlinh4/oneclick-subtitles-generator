use base64::{Engine as _, engine::general_purpose::STANDARD};
use minisign_verify::PublicKey;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_updater::UpdaterExt;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio_util::sync::CancellationToken;

use crate::diagnostics;
use crate::error::{CommandError, CommandResult};

const UPDATE_SIGNING_PUBLIC_KEY: &str = include_str!("../updater-public-key.txt");
const MAX_RELEASE_NOTES_UTF16_UNITS: usize = 32 * 1024;
const MAX_VERSION_LENGTH: usize = 64;
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_mins(30);
#[cfg(feature = "ci-updater-fixture")]
const CI_UPDATE_ENDPOINT: &str = "https://localhost:38443/latest.json";

#[derive(Default)]
pub(crate) struct AppUpdateRuntime {
    active: Mutex<Option<ActiveUpdate>>,
}

struct ActiveUpdate {
    version: String,
    cancellation: CancellationToken,
}

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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum AppUpdateEvent {
    Checking {
        version: String,
    },
    Progress {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        basis_points: Option<u16>,
    },
    Installing {
        version: String,
    },
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

    let update = build_updater(&app, UPDATE_CHECK_TIMEOUT)?
        .check()
        .await
        .map_err(|_| CommandError::updater_unavailable())?
        .map(|release| {
            if release.version.is_empty() || release.version.len() > MAX_VERSION_LENGTH {
                return Err(CommandError::updater_unavailable());
            }
            Ok(AppUpdateInfo {
                version: release.version,
                published_at: release.date.map(format_published_at).transpose()?,
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

#[tauri::command]
pub(crate) async fn app_update_install<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, AppUpdateRuntime>,
    expected_version: String,
    on_event: Channel<AppUpdateEvent>,
) -> CommandResult<()> {
    if !has_configured_signing_key() || !is_bounded_version(&expected_version) {
        return Err(CommandError::updater_unavailable());
    }
    let cancellation = runtime.begin(&expected_version)?;
    let result = install_checked_update(&app, &expected_version, &on_event, &cancellation).await;
    runtime.finish(&expected_version)?;
    result
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments are deserialized and owned by the generated IPC wrapper"
)]
pub(crate) fn app_update_cancel(
    runtime: State<'_, AppUpdateRuntime>,
    expected_version: String,
) -> CommandResult<bool> {
    runtime.cancel(&expected_version)
}

async fn install_checked_update<R: Runtime>(
    app: &AppHandle<R>,
    expected_version: &str,
    on_event: &Channel<AppUpdateEvent>,
    cancellation: &CancellationToken,
) -> CommandResult<()> {
    diagnostics::record(
        "app-update.checking",
        &[("version", expected_version.to_owned())],
    );
    send_event(
        on_event,
        AppUpdateEvent::Checking {
            version: expected_version.to_owned(),
        },
        cancellation,
    )?;
    let mut update = build_updater(app, UPDATE_CHECK_TIMEOUT)?
        .check()
        .await
        .map_err(|_| CommandError::updater_unavailable())?
        .ok_or_else(CommandError::updater_stale)?;
    if update.version != expected_version {
        return Err(CommandError::updater_stale());
    }
    update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);

    let event_channel = on_event.clone();
    let channel_cancellation = cancellation.clone();
    let mut downloaded_bytes = 0_u64;
    let download = update.download(
        move |chunk_length, total_bytes| {
            downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
            let basis_points = total_bytes.filter(|total| *total > 0).map(|total| {
                let scaled = u128::from(downloaded_bytes.min(total)) * 10_000;
                u16::try_from(scaled / u128::from(total)).unwrap_or(10_000)
            });
            if event_channel
                .send(AppUpdateEvent::Progress {
                    downloaded_bytes,
                    total_bytes,
                    basis_points,
                })
                .is_err()
            {
                channel_cancellation.cancel();
            }
        },
        || {},
    );
    tokio::pin!(download);
    let bytes = tokio::select! {
        result = &mut download => if let Ok(bytes) = result {
            bytes
        } else {
            record_update_failure("app-update.download_failed", "transport-or-signature");
            return Err(CommandError::updater_unavailable());
        },
        () = cancellation.cancelled() => {
            diagnostics::record(
                "app-update.cancelled",
                &[("phase", "download".to_owned())],
            );
            return Err(CommandError::updater_cancelled());
        },
    };
    if cancellation.is_cancelled() {
        return Err(CommandError::updater_cancelled());
    }
    diagnostics::record(
        "app-update.installing",
        &[("version", expected_version.to_owned())],
    );
    send_event(
        on_event,
        AppUpdateEvent::Installing {
            version: expected_version.to_owned(),
        },
        cancellation,
    )?;
    if update.install(bytes).is_err() {
        record_update_failure("app-update.install_failed", "extract-or-launch");
        return Err(CommandError::updater_unavailable());
    }
    Ok(())
}

fn record_update_failure(event: &'static str, reason: &'static str) {
    diagnostics::record(event, &[("reason", reason.to_owned())]);
}

fn build_updater<R: Runtime>(
    app: &AppHandle<R>,
    timeout: Duration,
) -> CommandResult<tauri_plugin_updater::Updater> {
    let builder = app.updater_builder().timeout(timeout);
    #[cfg(feature = "ci-updater-fixture")]
    let builder = builder
        .endpoints(vec![
            CI_UPDATE_ENDPOINT
                .parse()
                .map_err(|_| CommandError::updater_unavailable())?,
        ])
        .map_err(|_| CommandError::updater_unavailable())?
        // GitHub-hosted Windows runners can block indefinitely while adding an ephemeral
        // certificate to CurrentUser\Root. The fixture still uses HTTPS and the production
        // updater's signature verification; only this compile-time localhost client accepts the
        // fixture's self-signed transport certificate. Ordinary/release builds do not compile
        // this branch or its endpoint.
        .configure_client(|client| client.danger_accept_invalid_certs(true));
    builder
        .build()
        .map_err(|_| CommandError::updater_unavailable())
}

fn send_event(
    channel: &Channel<AppUpdateEvent>,
    event: AppUpdateEvent,
    cancellation: &CancellationToken,
) -> CommandResult<()> {
    channel.send(event).map_err(|_| {
        cancellation.cancel();
        CommandError::channel_closed()
    })
}

impl AppUpdateRuntime {
    fn begin(&self, version: &str) -> CommandResult<CancellationToken> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| CommandError::updater_unavailable())?;
        if active.is_some() {
            return Err(CommandError::updater_busy());
        }
        let cancellation = CancellationToken::new();
        *active = Some(ActiveUpdate {
            version: version.to_owned(),
            cancellation: cancellation.clone(),
        });
        Ok(cancellation)
    }

    fn cancel(&self, version: &str) -> CommandResult<bool> {
        let active = self
            .active
            .lock()
            .map_err(|_| CommandError::updater_unavailable())?;
        let Some(active) = active.as_ref().filter(|active| active.version == version) else {
            return Ok(false);
        };
        active.cancellation.cancel();
        Ok(true)
    }

    fn finish(&self, version: &str) -> CommandResult<()> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| CommandError::updater_unavailable())?;
        if active
            .as_ref()
            .is_some_and(|active| active.version == version)
        {
            active.take();
        }
        Ok(())
    }
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

fn is_bounded_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_VERSION_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
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

fn format_published_at(value: OffsetDateTime) -> CommandResult<String> {
    value
        .format(&Rfc3339)
        .map_err(|_| CommandError::updater_unavailable())
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::{
        AppUpdateRuntime, MAX_RELEASE_NOTES_UTF16_UNITS, bounded_text, format_published_at,
        is_bounded_version, is_valid_signing_key,
    };
    use time::macros::datetime;

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

    #[test]
    fn published_dates_are_emitted_as_frontend_compatible_rfc3339() {
        assert_eq!(
            format_published_at(datetime!(2026-08-12 12:36:11.123456789 UTC)).unwrap(),
            "2026-08-12T12:36:11.123456789Z"
        );
    }

    #[test]
    fn update_runtime_serializes_operations_and_cancels_only_the_exact_version() {
        let runtime = AppUpdateRuntime::default();
        let cancellation = runtime.begin("1.0.1").unwrap();
        assert!(runtime.begin("1.0.2").is_err());
        assert!(!runtime.cancel("1.0.2").unwrap());
        assert!(!cancellation.is_cancelled());
        assert!(runtime.cancel("1.0.1").unwrap());
        assert!(cancellation.is_cancelled());
        runtime.finish("1.0.1").unwrap();
        assert!(runtime.begin("1.0.2").is_ok());
    }

    #[test]
    fn expected_versions_are_bounded_before_the_network_is_touched() {
        assert!(is_bounded_version("1.0.0-rc.1"));
        assert!(!is_bounded_version(""));
        assert!(!is_bounded_version("../../installer.exe"));
        assert!(!is_bounded_version(&"1".repeat(65)));
    }
}
