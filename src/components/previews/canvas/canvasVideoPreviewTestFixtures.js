// Shared mocks and environment helpers for the CanvasVideoPreview suites. Each suite wires these
// mocks into its own `vi.mock` factories, since module mocks are hoisted per test file.
import { vi } from 'vitest';

import { MANAGED_FONT_PACKAGE } from '../../../services/fontIdentity';

const captureVideoFrame = vi.fn(video => video);
const drawFrame = vi.fn(() => ({
  drewVideo: true,
  overlayRebuilt: true,
  viewport: {
    left: 0, top: 0, width: 1_920, height: 1_080,
  },
}));

export const canvasPreviewMocks = {
  bakePreviewAtlas: vi.fn(() => ({ layout: { lines: [] } })),
  captureVideoFrame,
  drawFrame,
  previewFace: vi.fn(({ capability }) => (
    capability.managedPackInstalled
      ? { family: 'Google Sans Flex', source: 'managed-ready', weight: 400 }
      : null
  )),
  exactSystemProbe: vi.fn(() => true),
  createAtlasCanvas: vi.fn(() => ({ width: 1, height: 1 })),
  createCanvasSubtitleRenderer: vi.fn(() => ({
    captureVideoFrame,
    draw: drawFrame,
  })),
};

export const resetCanvasPreviewMocks = () => {
  const mocks = canvasPreviewMocks;
  vi.unstubAllGlobals();
  delete window.__OSG_FONT_READINESS__;
  vi.restoreAllMocks();
  mocks.bakePreviewAtlas.mockClear();
  mocks.captureVideoFrame.mockReset();
  mocks.captureVideoFrame.mockImplementation(video => video);
  mocks.createCanvasSubtitleRenderer.mockReset();
  mocks.createCanvasSubtitleRenderer.mockImplementation(() => ({
    captureVideoFrame: mocks.captureVideoFrame,
    draw: mocks.drawFrame,
  }));
  mocks.drawFrame.mockClear();
  mocks.previewFace.mockClear();
  mocks.createAtlasCanvas.mockReset();
  mocks.createAtlasCanvas.mockImplementation(() => ({ width: 1, height: 1 }));
};

/** A real-raster platform: the preview skips drawing under the jsdom user agent. */
export const spoofWindowsChrome = () => {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
};

/** Publish a ready managed font package to the font-readiness bridge. */
export const installReadyManagedFont = () => {
  window.__OSG_FONT_READINESS__ = {
    schema: 1,
    state: 'ready',
    family: MANAGED_FONT_PACKAGE.family,
    epoch: 1,
    reason: null,
    retryable: false,
    version: MANAGED_FONT_PACKAGE.version,
  };
};
