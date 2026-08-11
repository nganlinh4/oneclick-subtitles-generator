import { getCurrentWindow } from '@tauri-apps/api/window';
import { isDesktopRuntime } from './runtimeEnvironment';

const FONT_READY_TIMEOUT_MS = 3000;
const MANAGED_UI_FONT_FAMILY = 'Google Sans';
const FONT_COVERAGE_PROBES = Object.freeze([
  'OSG',
  'Tiếng Việt ă đ ơ ư',
  'Ž Ł Ā',
]);

const managedFontIsAvailable = () => (
  typeof window !== 'undefined' && window.__OSG_MANAGED_UI_FONT__ === true
);

const boundedWait = async (operation, timeoutMs, fallback) => {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const waitForFont = async ({
  fonts = typeof document === 'undefined' ? null : document.fonts,
  timeoutMs = FONT_READY_TIMEOUT_MS,
} = {}) => {
  if (!managedFontIsAvailable() || typeof fonts?.load !== 'function') return false;

  const styleReady = await boundedWait(
    window.__OSG_MANAGED_UI_FONT_READY__ ?? true,
    timeoutMs,
    false,
  ).catch(() => false);
  if (styleReady !== true) return false;

  const descriptor = `400 16px "${MANAGED_UI_FONT_FAMILY}"`;
  const loadedFaces = await boundedWait(
    Promise.all(FONT_COVERAGE_PROBES.map((text) => fonts.load(descriptor, text))),
    timeoutMs,
    null,
  ).catch(() => null);
  if (!Array.isArray(loadedFaces)
    || loadedFaces.some((faces) => !Array.isArray(faces) || faces.length === 0)) {
    return false;
  }
  if (typeof fonts.check === 'function'
    && FONT_COVERAGE_PROBES.some((text) => !fonts.check(descriptor, text))) {
    return false;
  }
  return true;
};

/** Reveal the hidden desktop window only after the managed UI font is usable. */
export const revealDesktopWindowWhenReady = async ({
  nativeRuntime = isDesktopRuntime,
  wait = waitForFont,
  show = () => getCurrentWindow().show(),
} = {}) => {
  if (!nativeRuntime()) return false;
  let loaded = false;
  try {
    loaded = await wait() === true;
  } catch {
    loaded = false;
  }
  if (loaded && typeof document !== 'undefined') {
    document.documentElement.classList.add('osg-managed-ui-font-ready');
  }
  await show();
  return true;
};

export {
  FONT_COVERAGE_PROBES,
  FONT_READY_TIMEOUT_MS,
  MANAGED_UI_FONT_FAMILY,
  waitForFont,
};
