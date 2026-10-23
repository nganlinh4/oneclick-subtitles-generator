//! Off-screen placement and HWND isolation outside the union of attached monitors.

use std::io;

#[cfg(feature = "e2e-automation")]
use super::AUTOMATION_WINDOW_GUARD;
use super::{LEGACY_SAFE_EDGE_X, OFFSCREEN_MARGIN_PX};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PixelRect {
    pub(super) left: i64,
    pub(super) top: i64,
    pub(super) right: i64,
    pub(super) bottom: i64,
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

    pub(super) fn union(self, other: Self) -> Self {
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

pub(super) fn virtual_desktop_bounds(
    monitors: impl IntoIterator<Item = (i32, i32, u32, u32)>,
) -> Option<PixelRect> {
    monitors
        .into_iter()
        .filter_map(|(x, y, width, height)| PixelRect::from_monitor(x, y, width, height))
        .reduce(PixelRect::union)
}

pub(super) fn offscreen_placement(
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
