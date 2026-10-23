//! Managed yt-dlp downloads: URL inspection, durable media publication and cancellation.

mod commands;
mod errors;
mod finish;
mod runtime;
mod types;

use std::time::Duration;

pub(crate) use self::commands::{
    download_cancel, download_inspect, download_start, download_status,
};
pub(crate) use self::runtime::{DownloadRuntime, DownloadRuntimeHandle};

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const INSPECTION_TIMEOUT: Duration = Duration::from_mins(2);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_hours(6);
const MAX_CONCURRENT_INSPECTIONS: usize = 4;
const MAX_CONCURRENT_DOWNLOADS: usize = 4;
const MAX_SUBTITLE_IPC_BYTES: u64 = 8 * 1024 * 1024;
#[cfg(feature = "e2e-automation")]
const EXACT_AUTOMATION_DOWNLOAD_URLS_ENV: &str = "OSG_E2E_EXACT_DOWNLOAD_URLS";
#[cfg(feature = "e2e-automation")]
const AUTOMATION_COOKIE_FILE_ENV: &str = "OSG_E2E_DOWNLOAD_COOKIE_FILE";
#[cfg(feature = "e2e-automation")]
const AUTOMATION_BROWSER_PROFILE_ENV: &str = "OSG_E2E_DOWNLOAD_BROWSER_PROFILE";
#[cfg(feature = "e2e-automation")]
const AUTOMATION_FIXTURE_ROOT_ENV: &str = "OSG_E2E_FIXTURE_ROOT";

#[cfg(test)]
mod tests;
