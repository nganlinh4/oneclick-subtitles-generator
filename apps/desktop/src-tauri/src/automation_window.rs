//! Native-window isolation for the compiled `WebDriver` channel.
//!
//! The automation surface must stay compositor-visible for video/GPU evidence, so minimizing or
//! permanently hiding it is not an option. The safe boundary is instead a non-focusable HWND whose
//! complete rectangle sits outside the union of every attached monitor.

use std::io;
#[cfg(any(feature = "e2e-automation", test))]
use std::path::{Path, PathBuf};

#[cfg(any(feature = "e2e-automation", test))]
use serde::Deserialize;

const OFFSCREEN_MARGIN_PX: i64 = 64;
#[cfg(any(feature = "e2e-automation", test))]
const MINIMUM_EPHEMERAL_PORT: u16 = 49_152;
#[cfg(any(feature = "e2e-automation", test))]
const FORBIDDEN_FIXED_WEBDRIVER_PORT: u16 = 4_445;
#[cfg(feature = "e2e-automation")]
const WEBDRIVER_IDENTITY_ENV: &str = "OSG_E2E_WEBDRIVER_IDENTITY";
#[cfg(feature = "e2e-automation")]
const WEBDRIVER_AUTHORIZATION_ENV: &str = "OSG_E2E_WEBDRIVER_AUTHORIZATION";
#[cfg(any(feature = "e2e-automation", test))]
const MANAGED_CACHE_OWNER: &str = "oneclick-subtitles-generator";
#[cfg(any(feature = "e2e-automation", test))]
const RUN_ROOT_PREFIX: &str = "osg-e2e-run-";
#[cfg(any(feature = "e2e-automation", test))]
const RUN_ROOT_AUTHORITY_FILE: &str = ".osg-e2e-authority";
#[cfg(any(feature = "e2e-automation", test))]
const RUN_ROOT_PARENT_FILE: &str = ".osg-e2e-staging-parent";
#[cfg(any(feature = "e2e-automation", test))]
const RUN_ROOT_STAGING_AUTHORITY_FILE: &str = ".osg-e2e-staging-authority.json";
#[cfg(feature = "e2e-automation")]
const AUTOMATION_WINDOW_GUARD: &str =
    "The automation build requires a non-focusable off-screen native window.";

/// One compiled owner for the off-screen harness capability. Keeping this read here prevents the
/// window builder, page-load hook, and post-create HWND isolation from drifting to different tests.
#[cfg(feature = "e2e-automation")]
pub(crate) fn offscreen_requested() -> bool {
    std::env::var_os("OSG_E2E_OFFSCREEN_WINDOW").is_some_and(|value| value == "1")
}
#[cfg(any(feature = "e2e-automation", test))]
pub(crate) const AUTOMATION_BROWSER_ARGUMENTS: &str = "--mute-audio";
#[cfg(any(feature = "e2e-automation", test))]
const WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS: [&str; 2] = [
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    "--autoplay-policy=no-user-gesture-required",
];
#[cfg(feature = "e2e-automation")]
pub(crate) const AUTOMATION_INTERACTION_GUARD_SCRIPT: &str = r#"
(() => {
  const refusal = 'The automation build refused an interactive desktop surface.';
  const rejectInteractiveSurface = () => Promise.reject(new DOMException(refusal, 'NotAllowedError'));
  const refuseInteractiveSurface = () => { throw new DOMException(refusal, 'NotAllowedError'); };
  const installRefusal = (owner, name, replacement) => {
    if (!owner || typeof owner[name] !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    try {
      Object.defineProperty(owner, name, {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? false,
        writable: descriptor?.writable ?? true,
        value: replacement,
      });
    } catch {
      try { owner[name] = replacement; } catch { /* verified below */ }
    }
    if (owner[name] !== replacement) throw new DOMException(refusal, 'SecurityError');
  };
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'mozRequestFullScreen', 'msRequestFullscreen']) {
    installRefusal(Element.prototype, name, rejectInteractiveSurface);
  }
  const inputClick = HTMLInputElement.prototype.click;
  Object.defineProperty(HTMLInputElement.prototype, 'click', {
    configurable: true,
    writable: true,
    value(...args) {
      if (this.type === 'file') throw new DOMException(refusal, 'NotAllowedError');
      return inputClick.apply(this, args);
    },
  });
  const inputShowPicker = HTMLInputElement.prototype.showPicker;
  if (typeof inputShowPicker === 'function') {
    Object.defineProperty(HTMLInputElement.prototype, 'showPicker', {
      configurable: true,
      writable: true,
      value(...args) {
        if (this.type === 'file') throw new DOMException(refusal, 'NotAllowedError');
        return inputShowPicker.apply(this, args);
      },
    });
  }
  const refuseFileSystemPicker = () => Promise.reject(new DOMException(refusal, 'NotAllowedError'));
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    installRefusal(window, name, refuseFileSystemPicker);
  }
  for (const name of [
    'print', 'alert', 'confirm', 'prompt',
    'focus', 'moveTo', 'moveBy', 'resizeTo', 'resizeBy',
  ]) {
    installRefusal(window, name, refuseInteractiveSurface);
  }
  // These APIs create native picture-in-picture windows, capture/device choosers, or permission
  // prompts even though no ordinary file dialog or top-level browser window is involved.
  installRefusal(window.HTMLVideoElement?.prototype, 'requestPictureInPicture', rejectInteractiveSurface);
  installRefusal(window.documentPictureInPicture, 'requestWindow', rejectInteractiveSurface);
  for (const name of ['getUserMedia', 'getDisplayMedia', 'selectAudioOutput']) {
    installRefusal(window.navigator?.mediaDevices, name, rejectInteractiveSurface);
  }
  installRefusal(window.navigator, 'share', rejectInteractiveSurface);
  installRefusal(window.navigator?.credentials, 'get', rejectInteractiveSurface);
  installRefusal(window.navigator?.credentials, 'create', rejectInteractiveSurface);
  installRefusal(window.RemotePlayback?.prototype, 'prompt', rejectInteractiveSurface);
  installRefusal(window.PaymentRequest?.prototype, 'show', rejectInteractiveSurface);
  installRefusal(window.EyeDropper?.prototype, 'open', rejectInteractiveSurface);
  installRefusal(window, 'open', () => null);
  window.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const fileInput = target?.closest('input[type="file"]');
    const anchor = target?.closest('a[href]');
    let externalAnchor = false;
    if (anchor) {
      try {
        const destination = new URL(anchor.href, window.location.href);
        externalAnchor = destination.origin !== window.location.origin
          || !['http:', 'https:'].includes(destination.protocol);
      } catch {
        externalAnchor = true;
      }
    }
    const targetName = anchor?.target?.toLowerCase() ?? '';
    const newBrowsingContext = targetName !== ''
      && !['_self', '_top', '_parent'].includes(targetName);
    const downloadAnchor = anchor?.hasAttribute?.('download') ?? false;
    const forbidden = fileInput || downloadAnchor || newBrowsingContext || externalAnchor;
    if (forbidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
})();
"#;
// Keep the long-standing harness assertion useful even on a conventional single-monitor desktop.
// The monitor-derived edge can move this farther left, never closer to the interactive desktop.
const LEGACY_SAFE_EDGE_X: i64 = -10_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PixelRect {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

impl PixelRect {
    fn from_monitor(x: i32, y: i32, width: u32, height: u32) -> Option<Self> {
        if width == 0 || height == 0 {
            return None;
        }
        Some(Self {
            left: i64::from(x),
            top: i64::from(y),
            right: i64::from(x) + i64::from(width),
            bottom: i64::from(y) + i64::from(height),
        })
    }

    fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AutomationWindowPlacement {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

fn virtual_desktop_bounds(
    monitors: impl IntoIterator<Item = (i32, i32, u32, u32)>,
) -> Option<PixelRect> {
    monitors
        .into_iter()
        .filter_map(|(x, y, width, height)| PixelRect::from_monitor(x, y, width, height))
        .reduce(PixelRect::union)
}

fn offscreen_placement(
    bounds: PixelRect,
    window_width: u32,
) -> io::Result<AutomationWindowPlacement> {
    if window_width == 0 {
        return Err(io::Error::other(
            "the automation window has no measurable width",
        ));
    }
    let safe_edge = bounds.left.min(LEGACY_SAFE_EDGE_X);
    let x = safe_edge
        .checked_sub(i64::from(window_width))
        .and_then(|value| value.checked_sub(OFFSCREEN_MARGIN_PX))
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| io::Error::other("no safe off-screen Windows coordinate exists"))?;
    let y = i32::try_from(bounds.top)
        .map_err(|_| io::Error::other("the Windows virtual desktop origin is invalid"))?;
    Ok(AutomationWindowPlacement { x, y })
}

#[cfg(any(feature = "e2e-automation", test))]
fn invalid_environment(reason: &str) -> io::Error {
    io::Error::other(format!(
        "the automation build refused an unsafe harness environment: {reason}"
    ))
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Debug)]
struct ManagedStagingEnvironment {
    cache_root: PathBuf,
    cache_root_id: String,
    staging_root: PathBuf,
    lease_id: String,
    lease_owner_process_id: u32,
    lease_owner_process_created_utc: String,
    run_root_authorization: String,
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DevelopmentCacheRootMarker {
    schema_version: u8,
    owner: String,
    cache_kind: String,
    root_id: String,
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagingEntryMarker {
    schema_version: u8,
    owner: String,
    root_id: String,
    lane: String,
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagingLeaseMarker {
    schema_version: u8,
    owner: String,
    root_id: String,
    lane_group: String,
    lease_id: String,
    process_id: u32,
    process_created_utc: String,
}

#[cfg(any(feature = "e2e-automation", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunStagingAuthority {
    schema_version: u8,
    managed: bool,
    owner: String,
    root_id: String,
    cache_root: PathBuf,
    staging_root: PathBuf,
    lease_id: String,
    lease_owner_process_id: u32,
    lease_owner_process_created_utc: String,
}

#[cfg(any(feature = "e2e-automation", test))]
fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(any(feature = "e2e-automation", test))]
fn same_path(left: &Path, right: &Path) -> bool {
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
fn is_ordinary_directory(path: &Path) -> io::Result<bool> {
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
fn read_owned_json<T: serde::de::DeserializeOwned>(path: &Path, label: &str) -> io::Result<T> {
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
fn read_owned_text(path: &Path, label: &str) -> io::Result<String> {
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
fn verify_live_process_creation_identity(
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
fn verify_live_process_creation_identity(_: u32, _: &str) -> io::Result<()> {
    Err(invalid_environment(
        "managed process creation identity requires Windows",
    ))
}

#[cfg(any(feature = "e2e-automation", test))]
fn validate_isolated_directory(
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

#[cfg(any(feature = "e2e-automation", test))]
#[allow(
    clippy::too_many_lines,
    reason = "the harness admission proof stays linear so every environment invariant is checked before authorization is returned"
)]
fn validate_harness_environment(
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
fn validate_webdriver_environment(
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

/// Make the real automation HWND non-activating and move it completely outside all monitors.
///
/// Tauri's safe APIs are intentional here. On Windows, `set_focusable(false)` is implemented by
/// Tao as `WS_EX_NOACTIVATE`, and `set_position` uses `SetWindowPos` with `SWP_NOACTIVATE`. This
/// preserves compositor rendering and `WebDriver` screenshots without introducing unsafe Win32 code
/// into a crate whose workspace policy forbids it.
#[cfg(feature = "e2e-automation")]
pub(crate) fn isolate(
    window: &tauri::Window,
) -> Result<AutomationWindowPlacement, Box<dyn std::error::Error>> {
    // No state transition below is allowed to activate the HWND. If a hostile/product path somehow
    // changed the native state between requests, make the surface non-activating first and hide it
    // only for the repair; it is shown again only after its complete rectangle is off every monitor.
    window
        .set_focusable(false)
        .map_err(|error| io::Error::other(format!("{AUTOMATION_WINDOW_GUARD} {error}")))?;
    window.set_skip_taskbar(true)?;
    let was_visible = window.is_visible()?;
    // `set_focusable(false)` prevents future activation, but Windows does not promise to revoke
    // focus that was somehow acquired before the style changed. Hiding a focused surface is the
    // fail-closed deactivation path; it is shown again only after the safe off-screen placement.
    let state_repair = window.is_focused()? || window.is_fullscreen()? || window.is_maximized()?;
    if state_repair && was_visible {
        window.hide()?;
    }
    if window.is_fullscreen()? {
        window.set_fullscreen(false)?;
    }
    if window.is_maximized()? {
        window.unmaximize()?;
    }

    let monitors = window.available_monitors()?;
    let bounds = virtual_desktop_bounds(monitors.iter().map(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        (position.x, position.y, size.width, size.height)
    }))
    .ok_or_else(|| io::Error::other("Windows reported no usable monitor bounds"))?;
    let window_size = window.outer_size()?;
    let placement = offscreen_placement(bounds, window_size.width)?;

    let current = window.outer_position()?;
    if current.x != placement.x || current.y != placement.y {
        window.set_position(tauri::PhysicalPosition::new(placement.x, placement.y))?;
    }
    if state_repair && was_visible {
        window.show()?;
    }
    Ok(placement)
}

#[cfg(test)]
mod tests {
    use super::{
        ManagedStagingEnvironment, PixelRect, automation_browser_arguments, offscreen_placement,
        validate_harness_environment, validate_isolated_directory, validate_webdriver_environment,
        virtual_desktop_bounds,
    };

    struct ManagedHarnessFixture {
        _enclosing: tempfile::TempDir,
        run: std::path::PathBuf,
        webview: std::path::PathBuf,
        staging: ManagedStagingEnvironment,
    }

    fn managed_harness_fixture() -> ManagedHarnessFixture {
        let enclosing = tempfile::tempdir().expect("managed cache fixture");
        let cache_root = enclosing.path().join("cache");
        let staging_root = cache_root.join("staging");
        let run = staging_root.join("osg-e2e-run-fixture");
        std::fs::create_dir_all(&run).expect("managed run root");
        for child in [
            "data", "cache", "logs", "webview", "evidence", "input", "output",
        ] {
            std::fs::create_dir(run.join(child)).expect("private run directory");
        }
        let root_id = "1".repeat(32);
        let lease_id = "2".repeat(32);
        let authorization = "3".repeat(64);
        let process_created_utc = "2026-08-26T01:02:03.0000000Z";
        std::fs::write(
            cache_root.join(".osg-development-cache.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "owner": "oneclick-subtitles-generator",
                "cacheKind": "development-cache",
                "rootId": root_id,
            }))
            .expect("root marker JSON"),
        )
        .expect("root marker");
        std::fs::write(
            staging_root.join(".osg-cache-entry.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "owner": "oneclick-subtitles-generator",
                "rootId": root_id,
                "lane": "staging",
            }))
            .expect("entry marker JSON"),
        )
        .expect("entry marker");
        std::fs::write(
            staging_root.join(".osg-cache-lease"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "owner": "oneclick-subtitles-generator",
                "rootId": root_id,
                "laneGroup": "staging",
                "leaseId": lease_id,
                "processId": 4242,
                "processCreatedUtc": process_created_utc,
            }))
            .expect("lease marker JSON"),
        )
        .expect("lease marker");
        let canonical_cache = cache_root.canonicalize().expect("canonical cache");
        let canonical_staging = staging_root.canonicalize().expect("canonical staging");
        std::fs::write(
            run.join(".osg-e2e-staging-parent"),
            format!("{}\n", canonical_staging.display()),
        )
        .expect("parent marker");
        std::fs::write(run.join(".osg-e2e-authority"), &authorization).expect("run authority");
        std::fs::write(
            run.join(".osg-e2e-staging-authority.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "managed": true,
                "owner": "oneclick-subtitles-generator",
                "rootId": root_id,
                "cacheRoot": canonical_cache,
                "stagingRoot": canonical_staging,
                "leaseId": lease_id,
                "leaseOwnerProcessId": 4242,
                "leaseOwnerProcessCreatedUtc": process_created_utc,
            }))
            .expect("run staging authority JSON"),
        )
        .expect("run staging authority");
        ManagedHarnessFixture {
            webview: run.join("webview"),
            run,
            staging: ManagedStagingEnvironment {
                cache_root,
                cache_root_id: root_id,
                staging_root,
                lease_id,
                lease_owner_process_id: 4242,
                lease_owner_process_created_utc: process_created_utc.to_owned(),
                run_root_authorization: authorization,
            },
            _enclosing: enclosing,
        }
    }

    #[test]
    fn unions_the_complete_multi_monitor_virtual_desktop() {
        let bounds = virtual_desktop_bounds([
            (0, 0, 1920, 1080),
            (-2560, -240, 2560, 1440),
            (1920, 120, 3840, 2160),
        ])
        .expect("the fixtures contain usable monitors");

        assert_eq!(
            bounds,
            PixelRect {
                left: -2560,
                top: -240,
                right: 5760,
                bottom: 2280,
            }
        );
    }

    #[test]
    fn moves_left_of_a_monitor_that_already_occupies_the_old_fixed_coordinate() {
        let bounds = virtual_desktop_bounds([(-12_000, 0, 16_000, 2160)])
            .expect("the fixture is a usable virtual desktop");
        let placement = offscreen_placement(bounds, 1416).expect("a safe placement exists");

        assert_eq!(placement.x, -13_480);
        assert_eq!(placement.y, 0);
        assert!(i64::from(placement.x) + 1416 < bounds.left);
    }

    #[test]
    fn keeps_conventional_desktops_behind_the_harness_safety_edge() {
        let bounds = virtual_desktop_bounds([(0, 0, 1920, 1080)])
            .expect("the fixture is a usable virtual desktop");
        let placement = offscreen_placement(bounds, 1416).expect("a safe placement exists");

        assert_eq!(placement.x, -11_480);
        assert!(i64::from(placement.x) + 1416 < -10_000);
    }

    #[test]
    fn refuses_missing_monitors_and_impossible_coordinates() {
        assert_eq!(virtual_desktop_bounds([]), None);
        let extreme = PixelRect {
            left: i64::from(i32::MIN),
            top: 0,
            right: i64::from(i32::MIN) + 1,
            bottom: 1,
        };
        assert!(offscreen_placement(extreme, 1416).is_err());
    }

    #[test]
    fn harness_environment_is_exactly_bounded_to_one_managed_staging_lease() {
        let fixture = managed_harness_fixture();

        validate_harness_environment(
            &fixture.run,
            &fixture.run,
            &fixture.webview,
            true,
            false,
            &fixture.staging,
        )
        .expect("the harness shape is valid");

        let outside = tempfile::tempdir().expect("outside root");
        assert!(
            validate_harness_environment(
                &fixture.run,
                outside.path(),
                &fixture.webview,
                true,
                false,
                &fixture.staging,
            )
            .is_err()
        );
        assert!(
            validate_harness_environment(
                &fixture.run,
                &fixture.run,
                &fixture.webview,
                false,
                false,
                &fixture.staging,
            )
            .is_err()
        );
        assert!(
            validate_harness_environment(
                &fixture.run,
                &fixture.run,
                &fixture.webview,
                true,
                true,
                &fixture.staging,
            )
            .is_err()
        );

        let mut wrong_lease = managed_harness_fixture();
        wrong_lease.staging.lease_id = "4".repeat(32);
        assert!(
            validate_harness_environment(
                &wrong_lease.run,
                &wrong_lease.run,
                &wrong_lease.webview,
                true,
                false,
                &wrong_lease.staging,
            )
            .is_err()
        );
    }

    #[test]
    fn harness_environment_rejects_a_live_or_redirected_profile() {
        let fixture = managed_harness_fixture();
        let enclosing = tempfile::tempdir().expect("non-harness root");
        let root = enclosing.path().join("osg-e2e-lookalike");
        let webview = root.join("webview");
        std::fs::create_dir_all(&webview).expect("lookalike profile");
        assert!(
            validate_harness_environment(&root, &root, &webview, true, false, &fixture.staging,)
                .is_err()
        );

        assert!(
            validate_harness_environment(
                &fixture.run,
                &fixture.run,
                &webview,
                true,
                false,
                &fixture.staging,
            )
            .is_err()
        );

        let redirected = tempfile::tempdir().expect("redirected data target");
        assert!(
            validate_isolated_directory(
                &fixture.run.canonicalize().expect("canonical run"),
                "data",
                &redirected.path().canonicalize().expect("redirect target"),
                true,
            )
            .is_err()
        );
    }

    #[test]
    fn automation_owns_a_closed_browser_argument_set() {
        assert_eq!(
            automation_browser_arguments(),
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --mute-audio"
        );
    }

    #[test]
    fn webdriver_environment_refuses_fixed_ports_and_unidentified_launches() {
        let identity = "a".repeat(64);
        let authorization = "b".repeat(64);
        validate_webdriver_environment(
            Some("true"),
            Some("55123"),
            Some(&identity),
            Some(&authorization),
        )
        .expect("the guarded binding shape is valid");
        assert!(
            validate_webdriver_environment(
                Some("true"),
                Some("4445"),
                Some(&identity),
                Some(&authorization),
            )
            .is_err()
        );
        assert!(
            validate_webdriver_environment(
                Some("true"),
                Some("55123"),
                Some("ABC"),
                Some(&authorization),
            )
            .is_err()
        );
        assert!(
            validate_webdriver_environment(
                None,
                Some("55123"),
                Some(&identity),
                Some(&authorization),
            )
            .is_err()
        );
        assert!(
            validate_webdriver_environment(
                Some("true"),
                Some("55123"),
                Some(&identity),
                Some(&identity),
            )
            .is_err()
        );
    }
}
