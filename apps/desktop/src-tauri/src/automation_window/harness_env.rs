//! Harness and `WebDriver` environment validation before any automation window exists.

use std::io;
#[cfg(any(feature = "e2e-automation", test))]
use std::path::{Path, PathBuf};

#[cfg(feature = "e2e-automation")]
use super::run_root::verify_live_process_creation_identity;
#[cfg(any(feature = "e2e-automation", test))]
use super::run_root::{
    DevelopmentCacheRootMarker, ManagedStagingEnvironment, RunStagingAuthority, StagingEntryMarker,
    StagingLeaseMarker, invalid_environment, is_lower_hex, is_ordinary_directory, read_owned_json,
    read_owned_text, same_path, validate_isolated_directory,
};
#[cfg(any(feature = "e2e-automation", test))]
use super::{
    AUTOMATION_BROWSER_ARGUMENTS, FORBIDDEN_FIXED_WEBDRIVER_PORT, MANAGED_CACHE_OWNER,
    MINIMUM_EPHEMERAL_PORT, RUN_ROOT_AUTHORITY_FILE, RUN_ROOT_PARENT_FILE, RUN_ROOT_PREFIX,
    RUN_ROOT_STAGING_AUTHORITY_FILE, WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS,
};
#[cfg(feature = "e2e-automation")]
use super::{WEBDRIVER_AUTHORIZATION_ENV, WEBDRIVER_IDENTITY_ENV, offscreen_requested};

#[cfg(any(feature = "e2e-automation", test))]
#[allow(
    clippy::too_many_lines,
    reason = "the harness admission proof stays linear so every environment invariant is checked before authorization is returned"
)]
pub(super) fn validate_harness_environment(
    data_root: &Path,
    fixture_root: &Path,
    webview_root: &Path,
    offscreen: bool,
    has_ambient_browser_arguments: bool,
    managed_staging: &ManagedStagingEnvironment,
) -> io::Result<()> {
    if !offscreen
        || !data_root.is_absolute()
        || !fixture_root.is_absolute()
        || !webview_root.is_absolute()
    {
        return Err(invalid_environment(
            "off-screen mode and absolute isolated roots are mandatory",
        ));
    }
    if has_ambient_browser_arguments {
        return Err(invalid_environment(
            "ambient WebView2 browser arguments are forbidden",
        ));
    }
    let data_root = data_root
        .canonicalize()
        .map_err(|_| invalid_environment("the data root does not exist"))?;
    let fixture_root = fixture_root
        .canonicalize()
        .map_err(|_| invalid_environment("the fixture root does not exist"))?;
    let webview_root = webview_root
        .canonicalize()
        .map_err(|_| invalid_environment("the WebView profile root does not exist"))?;
    let cache_root = managed_staging
        .cache_root
        .canonicalize()
        .map_err(|_| invalid_environment("the managed development-cache root is unavailable"))?;
    let staging_root = managed_staging
        .staging_root
        .canonicalize()
        .map_err(|_| invalid_environment("the managed staging lane is unavailable"))?;
    let expected_webview = data_root
        .join("webview")
        .canonicalize()
        .map_err(|_| invalid_environment("the run root has no private WebView profile"))?;
    let run_name = data_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    if !is_ordinary_directory(&cache_root)?
        || !is_ordinary_directory(&staging_root)?
        || !is_ordinary_directory(&data_root)?
        || staging_root
            .parent()
            .is_none_or(|parent| !same_path(parent, &cache_root))
        || staging_root.file_name().and_then(|value| value.to_str()) != Some("staging")
        || data_root
            .parent()
            .is_none_or(|parent| !same_path(parent, &staging_root))
        || !run_name.starts_with(RUN_ROOT_PREFIX)
        || run_name.len() <= RUN_ROOT_PREFIX.len()
    {
        return Err(invalid_environment(
            "the data root is not one ordinary direct child of the managed staging lane",
        ));
    }

    let root_marker: DevelopmentCacheRootMarker = read_owned_json(
        &cache_root.join(".osg-development-cache.json"),
        "the managed development-cache root marker",
    )?;
    let entry_marker: StagingEntryMarker = read_owned_json(
        &staging_root.join(".osg-cache-entry.json"),
        "the managed staging entry marker",
    )?;
    let lease_marker: StagingLeaseMarker = read_owned_json(
        &staging_root.join(".osg-cache-lease"),
        "the managed staging lease marker",
    )?;
    let run_staging: RunStagingAuthority = read_owned_json(
        &data_root.join(RUN_ROOT_STAGING_AUTHORITY_FILE),
        "the isolated run staging authority",
    )?;
    let parent_authority = read_owned_text(
        &data_root.join(RUN_ROOT_PARENT_FILE),
        "the isolated run staging-parent marker",
    )?;
    let authorized_parent = PathBuf::from(parent_authority)
        .canonicalize()
        .map_err(|_| invalid_environment("the isolated run staging parent is unavailable"))?;
    let run_authorization = read_owned_text(
        &data_root.join(RUN_ROOT_AUTHORITY_FILE),
        "the isolated run private authority",
    )?;
    let run_cache_root = run_staging
        .cache_root
        .canonicalize()
        .map_err(|_| invalid_environment("the run staging authority changed its cache root"))?;
    let run_staging_root = run_staging
        .staging_root
        .canonicalize()
        .map_err(|_| invalid_environment("the run staging authority changed its staging root"))?;
    if root_marker.schema_version != 1
        || root_marker.owner != MANAGED_CACHE_OWNER
        || root_marker.cache_kind != "development-cache"
        || !is_lower_hex(&root_marker.root_id, 32)
        || entry_marker.schema_version != 1
        || entry_marker.owner != root_marker.owner
        || entry_marker.root_id != root_marker.root_id
        || entry_marker.lane != "staging"
        || lease_marker.schema_version != 1
        || lease_marker.owner != root_marker.owner
        || lease_marker.root_id != root_marker.root_id
        || lease_marker.lane_group != "staging"
        || !is_lower_hex(&lease_marker.lease_id, 32)
        || lease_marker.process_id == 0
        || lease_marker.process_created_utc.is_empty()
        || run_staging.schema_version != 1
        || !run_staging.managed
        || run_staging.owner != root_marker.owner
        || run_staging.root_id != root_marker.root_id
        || !same_path(&run_cache_root, &cache_root)
        || !same_path(&run_staging_root, &staging_root)
        || run_staging.lease_id != lease_marker.lease_id
        || run_staging.lease_owner_process_id != lease_marker.process_id
        || run_staging.lease_owner_process_created_utc != lease_marker.process_created_utc
        || !same_path(&authorized_parent, &staging_root)
        || managed_staging.cache_root_id != root_marker.root_id
        || managed_staging.lease_id != lease_marker.lease_id
        || managed_staging.lease_owner_process_id != lease_marker.process_id
        || managed_staging.lease_owner_process_created_utc != lease_marker.process_created_utc
        || !is_lower_hex(&run_authorization, 64)
        || managed_staging.run_root_authorization != run_authorization
    {
        return Err(invalid_environment(
            "the isolated run does not match its exact active managed staging lease",
        ));
    }
    if fixture_root != data_root {
        return Err(invalid_environment(
            "the staged-dialog capability is not bound to the isolated data root",
        ));
    }
    if webview_root != expected_webview {
        return Err(invalid_environment(
            "the WebView profile is not bound to the isolated data root",
        ));
    }
    for child in [
        "data", "cache", "logs", "webview", "evidence", "input", "output",
    ] {
        let expected = data_root.join(child);
        if !is_ordinary_directory(&expected)? {
            return Err(invalid_environment(
                "an isolated run directory is a link or reparse point",
            ));
        }
        let resolved = expected
            .canonicalize()
            .map_err(|_| invalid_environment("the isolated run layout is incomplete"))?;
        validate_isolated_directory(&data_root, child, &resolved, resolved.is_dir())?;
    }
    Ok(())
}

#[cfg(any(feature = "e2e-automation", test))]
pub(super) fn validate_webdriver_environment(
    embedded_server: Option<&str>,
    port: Option<&str>,
    identity: Option<&str>,
    authorization: Option<&str>,
) -> io::Result<()> {
    if embedded_server != Some("true") {
        return Err(invalid_environment(
            "the embedded WebDriver service did not launch this process",
        ));
    }
    let port = port
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value >= MINIMUM_EPHEMERAL_PORT)
        .ok_or_else(|| invalid_environment("a fresh high loopback WebDriver port is mandatory"))?;
    if port == FORBIDDEN_FIXED_WEBDRIVER_PORT {
        return Err(invalid_environment(
            "the fixed default WebDriver port is forbidden",
        ));
    }
    let identity = identity.unwrap_or_default();
    let authorization = authorization.unwrap_or_default();
    let is_token = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if !is_token(identity) || !is_token(authorization) || identity == authorization {
        return Err(invalid_environment(
            "distinct 256-bit WebDriver identity and authorization values are mandatory",
        ));
    }
    Ok(())
}

#[cfg(any(feature = "e2e-automation", test))]
pub(crate) fn automation_browser_arguments() -> String {
    let mut arguments = String::new();
    for required in WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS
        .into_iter()
        .chain([AUTOMATION_BROWSER_ARGUMENTS])
    {
        if !arguments
            .split_ascii_whitespace()
            .any(|argument| argument == required)
        {
            if !arguments.is_empty() {
                arguments.push(' ');
            }
            arguments.push_str(required);
        }
    }
    arguments
}

/// Refuse to start the automation-only binary outside the guarded harness.
///
/// This runs before Tauri creates its window or resolves application data. The environment is not
/// a convenience override: it is the authority that prevents a directly launched test executable
/// from opening on the interactive desktop or reading a customer's real profile.
#[cfg(feature = "e2e-automation")]
pub(crate) fn require_harness_environment() -> io::Result<()> {
    let required_path = |key| {
        std::env::var_os(key)
            .map(std::path::PathBuf::from)
            .ok_or_else(|| invalid_environment(key))
    };
    let data_root = required_path("OSG_E2E_DATA_ROOT")?;
    let fixture_root = required_path("OSG_E2E_FIXTURE_ROOT")?;
    let webview_root = required_path("WEBVIEW2_USER_DATA_FOLDER")?;
    let webdriver_root = required_path("OSG_E2E_WEBDRIVER_RUN_ROOT")?;
    let required_value = |key| std::env::var(key).map_err(|_| invalid_environment(key));
    let managed_staging = ManagedStagingEnvironment {
        cache_root: required_path("OSG_E2E_CACHE_ROOT")?,
        cache_root_id: required_value("OSG_E2E_CACHE_ROOT_ID")?,
        staging_root: required_path("OSG_E2E_STAGING_ROOT")?,
        lease_id: required_value("OSG_E2E_STAGING_LEASE_ID")?,
        lease_owner_process_id: required_value("OSG_E2E_STAGING_LEASE_OWNER_PID")?
            .parse::<u32>()
            .map_err(|_| invalid_environment("OSG_E2E_STAGING_LEASE_OWNER_PID"))?,
        lease_owner_process_created_utc: required_value("OSG_E2E_STAGING_LEASE_OWNER_CREATED_UTC")?,
        run_root_authorization: required_value("OSG_E2E_RUN_ROOT_AUTHORIZATION")?,
    };
    let offscreen = offscreen_requested();
    let has_ambient_browser_arguments = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .is_some_and(|value| !value.is_empty());
    verify_live_process_creation_identity(
        managed_staging.lease_owner_process_id,
        &managed_staging.lease_owner_process_created_utc,
    )?;
    validate_harness_environment(
        &data_root,
        &fixture_root,
        &webview_root,
        offscreen,
        has_ambient_browser_arguments,
        &managed_staging,
    )?;
    if webdriver_root.canonicalize().ok() != data_root.canonicalize().ok() {
        return Err(invalid_environment(
            "the WebDriver binding belongs to a different isolated run",
        ));
    }
    validate_webdriver_environment(
        std::env::var("WDIO_EMBEDDED_SERVER").ok().as_deref(),
        std::env::var("TAURI_WEBDRIVER_PORT").ok().as_deref(),
        std::env::var(WEBDRIVER_IDENTITY_ENV).ok().as_deref(),
        std::env::var(WEBDRIVER_AUTHORIZATION_ENV).ok().as_deref(),
    )
}
