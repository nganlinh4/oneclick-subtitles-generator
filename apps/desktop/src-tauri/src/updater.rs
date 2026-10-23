use std::sync::Mutex;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use minisign_verify::PublicKey;
use serde::{Deserialize, Serialize};
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

/// What this build is allowed to do about updates, decided before anything touches the network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpdateChannelState {
    /// An unsigned local-test build. It must make no update request at all.
    Disabled,
    /// No usable signing key is compiled in, so nothing could be verified even if it were fetched.
    Unconfigured,
    /// The shipped configuration: check, and verify what comes back.
    Enabled,
}

impl UpdateChannelState {
    /// The diagnostic word recorded for a check that never reached the network.
    ///
    /// `Enabled` has no word here on purpose — its outcome is decided by what the check returns,
    /// and giving it one would invite a caller to report an outcome before there is one.
    const fn quiescent_outcome(self) -> Option<&'static str> {
        match self {
            Self::Disabled => Some("disabled"),
            Self::Unconfigured => Some("unconfigured"),
            Self::Enabled => None,
        }
    }

    /// Whether the caller may open a network connection.
    const fn may_check(self) -> bool {
        matches!(self, Self::Enabled)
    }
}

/// The channel this binary was compiled as.
///
/// The feature is checked BEFORE the key, so a local-test build reports `Disabled` rather than
/// borrowing `Unconfigured`'s meaning. The two are different facts: one says this build was never
/// meant to update, the other says a build that was meant to cannot verify what it downloads. A
/// user reading the second when the first is true would reasonably think something is broken.
pub(crate) fn update_channel_state() -> UpdateChannelState {
    if cfg!(any(
        feature = "unsigned-local-build",
        feature = "e2e-automation"
    )) {
        return UpdateChannelState::Disabled;
    }
    if has_configured_signing_key() {
        UpdateChannelState::Enabled
    } else {
        UpdateChannelState::Unconfigured
    }
}

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
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AppUpdateCancelReason {
    User,
    Protocol,
}

impl AppUpdateCancelReason {
    const fn diagnostic(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Protocol => "protocol",
        }
    }
}

#[tauri::command]
pub(crate) async fn app_update_check<R: Runtime>(
    app: AppHandle<R>,
) -> CommandResult<AppUpdateStatus> {
    let current_version = app.package_info().version.to_string();
    diagnostics::record(
        "app-update.check_started",
        &[("version", current_version.clone())],
    );
    // Decided from the compiled channel, before anything opens a socket. An unsigned local-test
    // build must be silent on the network, not merely unable to verify what it hears back.
    let channel = update_channel_state();
    if let Some(outcome) = channel.quiescent_outcome() {
        diagnostics::record(
            "app-update.check_completed",
            &[
                ("version", current_version.clone()),
                ("outcome", outcome.to_owned()),
            ],
        );
        return Ok(AppUpdateStatus {
            configured: false,
            current_version,
            update: None,
        });
    }
    debug_assert!(channel.may_check());

    let update_result: CommandResult<Option<AppUpdateInfo>> = async {
        build_updater(&app, UPDATE_CHECK_TIMEOUT)?
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
            .transpose()
    }
    .await;
    let update = match update_result {
        Ok(update) => update,
        Err(error) => {
            diagnostics::record(
                "app-update.check_completed",
                &[
                    ("version", current_version.clone()),
                    ("outcome", "error".to_owned()),
                ],
            );
            return Err(error);
        }
    };
    diagnostics::record(
        "app-update.check_completed",
        &[
            ("version", current_version.clone()),
            (
                "outcome",
                if update.is_some() {
                    "available"
                } else {
                    "current"
                }
                .to_owned(),
            ),
        ],
    );

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
    // The same channel decision guards the install, not only the check. A build that must not ask
    // whether an update exists must certainly not download and run one, and refusing here means a
    // caller that skipped the check cannot reach the installer through a crafted version string.
    if !update_channel_state().may_check() || !is_bounded_version(&expected_version) {
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
    reason: AppUpdateCancelReason,
) -> CommandResult<bool> {
    let cancelled = runtime.cancel(&expected_version)?;
    if cancelled {
        diagnostics::record(
            "app-update.cancel_requested",
            &[("reason", reason.diagnostic().to_owned())],
        );
    }
    Ok(cancelled)
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
    let webview_debug = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .is_some_and(|value| !value.is_empty());
    #[cfg(feature = "ci-updater-fixture")]
    let webview_debug =
        webview_debug || crate::ci_updater_fixture::configuration().enables_webview_debugging();
    diagnostics::record(
        "app-update.handoff",
        &[
            ("version", expected_version.to_owned()),
            (
                "webviewDebug",
                if webview_debug { "present" } else { "absent" }.to_owned(),
            ),
        ],
    );
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
mod tests;
