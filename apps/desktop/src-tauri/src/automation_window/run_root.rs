//! Managed run-root markers and owned-file reads that prove an isolated harness directory.

use std::io;
#[cfg(any(feature = "e2e-automation", test))]
use std::path::{Path, PathBuf};

#[cfg(any(feature = "e2e-automation", test))]
use serde::Deserialize;

#[cfg(any(feature = "e2e-automation", test))]
pub(super) fn invalid_environment(reason: &str) -> io::Error {
    io::Error::other(format!(
        "the automation build refused an unsafe harness environment: {reason}"
    ))
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Debug)]
pub(super) struct ManagedStagingEnvironment {
    pub(super) cache_root: PathBuf,
    pub(super) cache_root_id: String,
    pub(super) staging_root: PathBuf,
    pub(super) lease_id: String,
    pub(super) lease_owner_process_id: u32,
    pub(super) lease_owner_process_created_utc: String,
    pub(super) run_root_authorization: String,
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DevelopmentCacheRootMarker {
    pub(super) schema_version: u8,
    pub(super) owner: String,
    pub(super) cache_kind: String,
    pub(super) root_id: String,
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StagingEntryMarker {
    pub(super) schema_version: u8,
    pub(super) owner: String,
    pub(super) root_id: String,
    pub(super) lane: String,
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StagingLeaseMarker {
    pub(super) schema_version: u8,
    pub(super) owner: String,
    pub(super) root_id: String,
    pub(super) lane_group: String,
    pub(super) lease_id: String,
    pub(super) process_id: u32,
    pub(super) process_created_utc: String,
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RunStagingAuthority {
    pub(super) schema_version: u8,
    pub(super) managed: bool,
    pub(super) owner: String,
    pub(super) root_id: String,
    pub(super) cache_root: PathBuf,
    pub(super) staging_root: PathBuf,
    pub(super) lease_id: String,
    pub(super) lease_owner_process_id: u32,
    pub(super) lease_owner_process_created_utc: String,
}

#[cfg(any(feature = "e2e-automation", test))]
pub(super) fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(any(feature = "e2e-automation", test))]
pub(super) fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(any(feature = "e2e-automation", test))]
pub(super) fn is_ordinary_directory(path: &Path) -> io::Result<bool> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(any(feature = "e2e-automation", test))]
pub(super) fn read_owned_json<T: serde::de::DeserializeOwned>(
    path: &Path,
    label: &str,
) -> io::Result<T> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| invalid_environment(&format!("{label} is missing")))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid_environment(&format!(
            "{label} is not an ordinary marker file"
        )));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(invalid_environment(&format!("{label} is a reparse point")));
        }
    }
    let bytes =
        std::fs::read(path).map_err(|_| invalid_environment(&format!("{label} cannot be read")))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| invalid_environment(&format!("{label} has an invalid schema")))
}

#[cfg(any(feature = "e2e-automation", test))]
pub(super) fn read_owned_text(path: &Path, label: &str) -> io::Result<String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| invalid_environment(&format!("{label} is missing")))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid_environment(&format!(
            "{label} is not an ordinary marker file"
        )));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(invalid_environment(&format!("{label} is a reparse point")));
        }
    }
    std::fs::read_to_string(path)
        .map(|value| value.trim().to_owned())
        .map_err(|_| invalid_environment(&format!("{label} cannot be read")))
}

#[cfg(all(feature = "e2e-automation", windows))]
pub(super) fn verify_live_process_creation_identity(
    process_id: u32,
    expected_created_utc: &str,
) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if process_id == 0
        || expected_created_utc.len() > 64
        || !expected_created_utc.is_ascii()
        || !expected_created_utc.ends_with('Z')
    {
        return Err(invalid_environment(
            "the managed staging lease owner creation identity is malformed",
        ));
    }
    let script = format!(
        "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter 'ProcessId = {process_id}' -OperationTimeoutSec 3 -ErrorAction Stop); if($p.Count -ne 1){{throw 'missing or ambiguous process'}}; ([DateTime]$p[0].CreationDate).ToUniversalTime().ToString('O')"
    );
    let mut command = Command::new("pwsh");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    for variable in [
        "OSG_E2E_CACHE_ROOT",
        "OSG_E2E_CACHE_ROOT_ID",
        "OSG_E2E_RUN_ROOT_AUTHORIZATION",
        "OSG_E2E_STAGING_LEASE_ID",
        "OSG_E2E_STAGING_LEASE_OWNER_CREATED_UTC",
        "OSG_E2E_STAGING_LEASE_OWNER_PID",
        "OSG_E2E_STAGING_ROOT",
        "OSG_E2E_WEBDRIVER_AUTHORIZATION",
        "OSG_E2E_WEBDRIVER_IDENTITY",
    ] {
        command.env_remove(variable);
    }
    let mut child = command.spawn().map_err(|_| {
        invalid_environment("the managed staging lease owner could not be inspected")
    })?;
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|_| invalid_environment("managed process inspection failed"))?
            .is_some()
        {
            break;
        }
        if started.elapsed() >= Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(invalid_environment(
                "managed process inspection exceeded its five-second deadline",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child
        .wait_with_output()
        .map_err(|_| invalid_environment("managed process inspection output was unavailable"))?;
    let actual_created_utc = String::from_utf8(output.stdout)
        .map_err(|_| invalid_environment("managed process inspection returned non-UTF-8 output"))?;
    if !output.status.success() || actual_created_utc.trim() != expected_created_utc {
        return Err(invalid_environment(
            "the managed staging lease owner PID was reused or its creation identity changed",
        ));
    }
    Ok(())
}

#[cfg(all(feature = "e2e-automation", not(windows)))]
pub(super) fn verify_live_process_creation_identity(_: u32, _: &str) -> io::Result<()> {
    Err(invalid_environment(
        "managed process creation identity requires Windows",
    ))
}

#[cfg(any(feature = "e2e-automation", test))]
pub(super) fn validate_isolated_directory(
    data_root: &Path,
    child: &str,
    resolved: &Path,
    is_directory: bool,
) -> io::Result<()> {
    if resolved != data_root.join(child) || !is_directory {
        return Err(invalid_environment(
            "an isolated run directory escapes through a link or reparse point",
        ));
    }
    Ok(())
}
