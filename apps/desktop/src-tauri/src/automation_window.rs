//! Native-window isolation for the compiled `WebDriver` channel.
//!
//! The automation surface must stay compositor-visible for video/GPU evidence, so minimizing or
//! permanently hiding it is not an option. The safe boundary is instead a non-focusable HWND whose
//! complete rectangle sits outside the union of every attached monitor.

mod harness_env;
mod placement;
mod run_root;

#[cfg(feature = "e2e-automation")]
pub(crate) use self::harness_env::{automation_browser_arguments, require_harness_environment};
#[cfg(feature = "e2e-automation")]
pub(crate) use self::placement::isolate;

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

#[cfg(test)]
mod tests;
