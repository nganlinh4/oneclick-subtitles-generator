import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { buildNativeRenderRequest } from '../../platform/renderService';
import { previewRenderRequest } from '../previews/native/nativePreviewScene';
import { defaultCustomization } from '../subtitleCustomization/defaultCustomization';
import { completeSubtitleCustomization } from './subtitleCustomizationState';

/**
 * The default merge, which used to happen on one side only.
 *
 * The render tab built its export request as `{ ...defaultCustomization, ...subtitleCustomization }`
 * in three places and handed the preview the state object raw. `normalizeCustomization` in
 * `renderService.js` takes an EXACT key set, so a style missing one key — a custom preset saved by an
 * older build, a hand-edited `localStorage` entry, `CustomPresetButtons` spreading a stored preset
 * straight into `onChange` — produced an export request and refused a preview request. The file
 * rendered; the panel went silently dormant. The two agreed only because the value that reached the
 * state had already been merged somewhere else, which is one decision in two places.
 *
 * The state is the authority now: every write goes through `completeSubtitleCustomization`, and the
 * export sites read it unmerged.
 */

const SOURCE_ASSET = Object.freeze({
  id: uuidv7(),
  displayName: 'source.mp4',
  extension: 'mp4',
  sizeBytes: 1_024,
  kind: 'video',
});

const SETTINGS = Object.freeze({
  resolution: '1080p',
  frameRate: 30,
  originalAudioVolume: 100,
  narrationVolume: 0,
  trimStart: 0,
  trimEnd: 0,
});

const CROP = Object.freeze({
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  aspectRatio: null,
  canvasBgMode: 'solid',
  canvasBgColor: '#000000',
  canvasBgBlur: 24,
  flipX: false,
  flipY: false,
});

/** The style with one key gone, which is the shape a stored preset arrives in. */
const missingOneKey = () => {
  const { letterSpacing, ...rest } = defaultCustomization;
  expect(letterSpacing).toBeDefined();
  return rest;
};

const exportRequestFor = (customization) => buildNativeRenderRequest({
  sourceAsset: SOURCE_ASSET,
  projectId: uuidv7(),
  lyrics: [{ id: 'a', start: 0, end: 1, text: 'cue' }],
  settings: SETTINGS,
  customization,
  crop: CROP,
});

const previewRequestFor = (customization) => previewRenderRequest({
  sourceAsset: SOURCE_ASSET,
  projectId: uuidv7(),
  cue: { start: 0, end: 1, text: 'cue' },
  customization,
  resolution: '1080p',
  frameRate: 30,
  crop: CROP,
});

describe('the subtitle style the render tab holds', () => {
  it('is what the preview and the export disagreed about when only one side merged', () => {
    const stored = missingOneKey();

    // The export side merged, so it built a request from a style the preview could not.
    expect(exportRequestFor({ ...defaultCustomization, ...stored })).not.toBeNull();
    // The preview side received it raw: `normalizeCustomization` wants an exact key set, and one
    // missing key is a refusal — which reaches the surface as dormancy, silently.
    expect(previewRequestFor(stored)).toBeNull();
  });

  it('completes a stored style once, so both sides build from the same object', () => {
    const completed = completeSubtitleCustomization(missingOneKey());

    expect(completed.letterSpacing).toBe(defaultCustomization.letterSpacing);
    expect(Object.keys(completed).sort()).toEqual(Object.keys(defaultCustomization).sort());
    expect(previewRequestFor(completed)).not.toBeNull();
    expect(exportRequestFor(completed)).not.toBeNull();
    // The same object on both sides, so the two cannot describe different styles.
    expect(exportRequestFor(completed).customization)
      .toEqual(previewRequestFor(completed).customization);
  });

  it('keeps every value the caller set and refuses to guess at a non-record', () => {
    const completed = completeSubtitleCustomization({ ...defaultCustomization, fontSize: 42 });
    expect(completed.fontSize).toBe(42);
    expect(Object.isFrozen(completed)).toBe(true);
    expect(completeSubtitleCustomization(null)).toEqual(defaultCustomization);
    expect(completeSubtitleCustomization(undefined)).toEqual(defaultCustomization);
  });

  /**
   * A VALUE out of bounds must still be refused by both sides, identically.
   *
   * The completion is a shallow spread rather than `mergeSubtitleCustomizationDefaults` for exactly
   * this reason: silently repairing a bad value would hide it from the export as well as from the
   * preview, and a style the user cannot actually get would render as one they can.
   */
  it('does not repair a value the render contract refuses', () => {
    const completed = completeSubtitleCustomization({ ...defaultCustomization, fontWeight: 450 });
    expect(completed.fontWeight).toBe(450);
    expect(previewRequestFor(completed)).toBeNull();
    expect(() => exportRequestFor(completed)).toThrow();
  });

  /**
   * The guard that keeps the authority single.
   *
   * Read from the source rather than asserted through a mounted component, because what has to stay
   * true is a property of the files: this module spreads the defaults, and the render tab does not
   * spread them at all. Three export sites each merging their own copy is the state this wave
   * removed, and a fourth would put the two surfaces back out of step without failing anything else.
   */
  it('is the only place the defaults are spread', () => {
    // Comments off first: the notes on both sides quote the merge they replaced, on purpose.
    const codeOf = (path) => readFileSync(resolve(path), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const authority = codeOf('src/components/VideoRenderingSection/subtitleCustomizationState.js');
    expect(authority.match(/\.\.\.defaultCustomization/g)).toHaveLength(1);

    const section = codeOf('src/components/VideoRenderingSection.js');
    expect(section).not.toContain('defaultCustomization');
    expect(section).not.toMatch(/\.\.\.\(?\s*(queueItem\?\.customization|subtitleCustomization)/);
    expect(section).toContain('useProjectRenderScene()');
    expect(section).toContain("updateSceneField('customization'");
  });
});
