import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CROP_SETTINGS } from './VideoRenderingSection/renderPreferences';
import VideoCropControls from './VideoCropControls';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback) => fallback,
  }),
}));

// The durable render-scene schema (`src/platform/projectRenderScene.js`) rejects a crop object
// whose keys don't exactly match `DEFAULT_CROP_SETTINGS`. A 4:3 source, matching the real "Me at
// the zoo" fixture the render-format-transform-matrix E2E journey renders against.
const FULL_CROP = Object.freeze({ ...DEFAULT_CROP_SETTINGS });
const VIDEO_DIMENSIONS = Object.freeze({ width: 480, height: 360, aspectRatio: 480 / 360 });

beforeAll(() => {
  // The video-tracking hook observes layout even though nothing here reads its output; the aspect
  // preset buttons render regardless of the measured rect.
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

const mount = (props = {}) => render(
  <VideoCropControls
    isEnabled
    cropSettings={FULL_CROP}
    videoDimensions={VIDEO_DIMENSIONS}
    onCropChange={vi.fn()}
    onToggle={vi.fn()}
    onApply={vi.fn()}
    onCancel={vi.fn()}
    onClear={vi.fn()}
    {...props}
  />,
);

describe('VideoCropControls aspect-ratio presets', () => {
  let onCropChange;

  beforeEach(() => {
    onCropChange = vi.fn();
  });

  it('emits every durable crop field when the 1:1 preset is clicked, not just x/y/width/height', () => {
    mount({ onCropChange });

    fireEvent.click(screen.getByTitle('1:1'));

    expect(onCropChange).toHaveBeenCalledTimes(1);
    const emitted = onCropChange.mock.calls[0][0];

    // The exact key set `normalizeProjectRenderSceneValues`'s `exactSnapshot(crop, CROP_KEYS)`
    // requires. Before the fix, `handleAspectRatioChange` built a fresh object from only
    // `calculateCropDimensions`'s return (x/y/width/height) plus flipX/flipY -- six keys instead
    // of ten -- which the durable scene authority rejected outright (an uncaught
    // `invalidProjectRenderScene`), aborting the caller before it could close crop mode. That is
    // why the customer's clicked preset never became durable and the crop editor stayed stuck
    // open, exactly as the render-format-transform-matrix journey observed.
    expect(Object.keys(emitted).sort()).toEqual(Object.keys(DEFAULT_CROP_SETTINGS).sort());

    // A 4:3 source cropped to 1:1 is narrower than the frame, not the untouched full frame.
    expect(emitted.width).toBeCloseTo(75, 5);
    expect(emitted.height).toBeCloseTo(100, 5);
    expect(emitted.x).toBeCloseTo(12.5, 5);
    expect(emitted.y).toBeCloseTo(0, 5);

    // The selected preset itself is now recorded rather than silently dropped.
    expect(emitted.aspectRatio).toBe(1);

    // Fields the preset click never touches must survive unchanged from the incoming crop.
    expect(emitted.canvasBgMode).toBe(FULL_CROP.canvasBgMode);
    expect(emitted.canvasBgColor).toBe(FULL_CROP.canvasBgColor);
    expect(emitted.canvasBgBlur).toBe(FULL_CROP.canvasBgBlur);
    expect(emitted.flipX).toBe(false);
    expect(emitted.flipY).toBe(false);
  });

  it('records a null aspectRatio (not an omitted field) for the Free preset', () => {
    mount({ onCropChange, cropSettings: { ...FULL_CROP, aspectRatio: 1, width: 75, height: 100, x: 12.5, y: 0 } });

    fireEvent.click(screen.getByTitle('Free'));

    const emitted = onCropChange.mock.calls[0][0];
    expect(Object.keys(emitted).sort()).toEqual(Object.keys(DEFAULT_CROP_SETTINGS).sort());
    expect(emitted.aspectRatio).toBeNull();
    expect(emitted.width).toBe(100);
    expect(emitted.height).toBe(100);
  });
});
