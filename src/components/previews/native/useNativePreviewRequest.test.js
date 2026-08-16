import { renderHook, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { stageGlyphAtlas } from '../../../platform/glyphAtlasStaging';
import { defaultCustomization } from '../../subtitleCustomization/defaultCustomization';
import { bakePreviewAtlas } from './nativePreviewScene';
import useNativePreviewRequest from './useNativePreviewRequest';

/**
 * The production caller of the `maxWidth` conversion.
 *
 * `nativePreviewScene.test.js` proves the arithmetic against a real bake; this proves that the hook
 * the editor actually mounts is the thing that performs it, at the resolution the editor is actually
 * composing at. A correct conversion that nothing calls would close the ledger entry on paper only.
 *
 * Only two things are mocked, and both for the same reason: jsdom has no canvas text stack and no
 * IPC. Everything between them — face resolution, cue selection, composition sizing, the conversion,
 * revision pairing — is the real module.
 */
vi.mock('../../../platform/glyphAtlasStaging', () => ({ stageGlyphAtlas: vi.fn() }));

vi.mock('./nativePreviewScene', async (importOriginal) => ({
  ...(await importOriginal()),
  bakePreviewAtlas: vi.fn(() => ({ contentHash: 'a1b2c3d4' })),
}));

const originalUserAgent = navigator.userAgent;

const asWindows = () => {
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2',
    configurable: true,
  });
  Object.defineProperty(document, 'fonts', {
    value: { check: () => true },
    configurable: true,
  });
};

afterAll(() => {
  Object.defineProperty(navigator, 'userAgent', { value: originalUserAgent, configurable: true });
});

const ATLAS = Object.freeze({ atlasId: 'staged', contentHash: 'a1b2c3d4' });

const SUBTITLES = Object.freeze([
  { start: 0, end: 2, text: 'First cue' },
  { start: 4, end: 6, text: 'Second cue' },
]);

const customization = (overrides = {}) => ({
  ...defaultCustomization,
  fontFamily: "'Arial', sans-serif",
  fontWeight: 400,
  fontSize: 50,
  maxWidth: 80,
  fadeInDuration: 0,
  fadeOutDuration: 0,
  ...overrides,
});

const props = (overrides = {}) => ({
  active: true,
  customization: customization(),
  subtitles: SUBTITLES,
  resolution: '1080p',
  frameRate: 30,
  sourceWidthPx: 1_920,
  sourceHeightPx: 1_080,
  durationSeconds: 10,
  currentTime: 1,
  ...overrides,
});

const lastBakeRequest = () => bakePreviewAtlas.mock.calls.at(-1)[0].request;

beforeEach(() => {
  asWindows();
  vi.mocked(stageGlyphAtlas).mockReset();
  vi.mocked(stageGlyphAtlas).mockResolvedValue(ATLAS);
  vi.mocked(bakePreviewAtlas).mockClear();
});

describe('the request the editor actually issues', () => {
  it('carries the converted wrap width at 1080p and the same one at 4K', async () => {
    const hd = renderHook((hookProps) => useNativePreviewRequest(hookProps), { initialProps: props() });
    await waitFor(() => expect(hd.result.current.atlas).toBe(ATLAS));
    const hdRequest = lastBakeRequest();

    const uhd = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ resolution: '4K' }) },
    );
    await waitFor(() => expect(uhd.result.current.atlas).toBe(ATLAS));
    const uhdRequest = lastBakeRequest();

    expect(hdRequest.maxWidthPx).toBe(1_536);
    expect(uhdRequest.maxWidthPx).toBe(1_536);
    // The composition is twice as wide at 4K, and the wrap width in atlas space is unchanged. That
    // is the whole conversion: the atlas is baked once and the compositor scales it.
    expect(hd.result.current.scene.widthPx).toBe(1_920);
    expect(uhd.result.current.scene.widthPx).toBe(3_840);
    expect(uhdRequest.fontSizePx).toBe(hdRequest.fontSizePx);
  });

  it('builds a scene for the cue on screen and a frame index for the playhead', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 5 }) },
    );
    await waitFor(() => expect(result.current.atlas).toBe(ATLAS));

    expect(result.current.scene.cues).toEqual([{
      text: 'Second cue',
      start: { numerator: 4_000, denominator: 1_000 },
      end: { numerator: 6_000, denominator: 1_000 },
    }]);
    expect(result.current.frameIndex).toBe(150);
    expect(lastBakeRequest().text).toBe('Second cue');
  });

  it('renders an instant with nothing on screen rather than refusing it', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 3 }) },
    );
    await waitFor(() => expect(result.current.atlas).toBe(ATLAS));

    expect(result.current.scene.cues).toEqual([]);
    expect(lastBakeRequest().text).toBe('');
  });

  it('does not re-bake or re-upload while the playhead moves inside one cue', async () => {
    const { result, rerender } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 0.5 }) },
    );
    await waitFor(() => expect(result.current.atlas).toBe(ATLAS));
    const bakes = bakePreviewAtlas.mock.calls.length;

    for (const currentTime of [0.6, 0.7, 0.8, 1.9]) {
      // A fresh array every render, exactly as `getCurrentSubtitles()` hands one over.
      rerender(props({ currentTime, subtitles: SUBTITLES.map((cue) => ({ ...cue })) }));
    }

    expect(bakePreviewAtlas.mock.calls.length).toBe(bakes);
    expect(stageGlyphAtlas).toHaveBeenCalledTimes(1);
    expect(result.current.frameIndex).toBe(57);
  });

  it('re-bakes when the style the baker owns changes', async () => {
    const { result, rerender } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props() },
    );
    await waitFor(() => expect(result.current.atlas).toBe(ATLAS));

    rerender(props({ customization: customization({ maxWidth: 50 }) }));
    await waitFor(() => expect(lastBakeRequest().maxWidthPx).toBe(960));
  });
});

describe('dormancy and refusal are different states', () => {
  it('is dormant, not failed, before the source has decoded a size', () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ sourceWidthPx: null, sourceHeightPx: null }) },
    );
    expect(result.current).toEqual({ scene: null, atlas: null, frameIndex: null, error: null });
    expect(bakePreviewAtlas).not.toHaveBeenCalled();
  });

  it('is dormant when the face has no verified byte source, rather than substituting one', () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ customization: customization({ fontFamily: 'Nonexistent Display' }) }) },
    );
    expect(result.current.scene).toBeNull();
    expect(bakePreviewAtlas).not.toHaveBeenCalled();
  });

  it('is dormant while this surface is not the one being judged', () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ active: false }) },
    );
    expect(result.current.scene).toBeNull();
    expect(bakePreviewAtlas).not.toHaveBeenCalled();
  });

  it('reports a bake refusal as an error, because that is a face the export would not use either', async () => {
    vi.mocked(bakePreviewAtlas).mockImplementationOnce(() => {
      const error = new Error('refused');
      error.code = 'glyphAtlasFaceSubstituted';
      throw error;
    });
    const { result } = renderHook((hookProps) => useNativePreviewRequest(hookProps), { initialProps: props() });

    await waitFor(() => expect(result.current.error).toEqual({ code: 'glyphAtlasFaceSubstituted' }));
    expect(result.current.atlas).toBeNull();
  });

  it('reports a staging refusal without retrying it', async () => {
    const rejection = new Error('rejected');
    rejection.code = 'glyphAtlasStagingRejected';
    vi.mocked(stageGlyphAtlas).mockRejectedValue(rejection);
    const { result } = renderHook((hookProps) => useNativePreviewRequest(hookProps), { initialProps: props() });

    await waitFor(() => expect(result.current.error).toEqual({ code: 'glyphAtlasStagingRejected' }));
    expect(stageGlyphAtlas).toHaveBeenCalledTimes(1);
  });
});
