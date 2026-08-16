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

const SOURCE_ASSET = Object.freeze({
  id: '019ffbea-26d5-7800-8e3b-69de8bff2d7d',
  displayName: 'source.mp4',
  extension: 'mp4',
  sizeBytes: 1_024,
  kind: 'video',
});
const PROJECT_ID = '019ffbea-40eb-7c3c-b2f3-214ca260a7cc';

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
  sourceAsset: SOURCE_ASSET,
  projectId: PROJECT_ID,
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
const stagedAtlas = (result) => result.current.request?.atlas ?? null;

beforeEach(() => {
  asWindows();
  vi.mocked(stageGlyphAtlas).mockReset();
  vi.mocked(stageGlyphAtlas).mockResolvedValue(ATLAS);
  vi.mocked(bakePreviewAtlas).mockClear();
});

describe('the request the editor actually issues', () => {
  it('carries the converted wrap width at 1080p and the same one at 4K', async () => {
    const hd = renderHook((hookProps) => useNativePreviewRequest(hookProps), { initialProps: props() });
    await waitFor(() => expect(stagedAtlas(hd.result)).toBe(ATLAS));
    const hdRequest = lastBakeRequest();

    const uhd = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ resolution: '4K' }) },
    );
    await waitFor(() => expect(stagedAtlas(uhd.result)).toBe(ATLAS));
    const uhdRequest = lastBakeRequest();

    expect(hdRequest.maxWidthPx).toBe(1_536);
    expect(uhdRequest.maxWidthPx).toBe(1_536);
    // The composition is twice as wide at 4K, and the wrap width in atlas space is unchanged. That
    // is the whole conversion: the atlas is baked once and the compositor scales it.
    expect(hd.result.current.request.composition).toEqual({ widthPx: 1_920, heightPx: 1_080 });
    expect(uhd.result.current.request.composition).toEqual({ widthPx: 3_840, heightPx: 2_160 });
    expect(uhdRequest.fontSizePx).toBe(hdRequest.fontSizePx);
  });

  it('builds a request for the cue on screen and a frame index for the playhead', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 5 }) },
    );
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));

    expect(result.current.request.render.lyrics).toEqual([{
      id: 'cue-0-0', startUs: 4_000_000, endUs: 6_000_000, text: 'Second cue',
    }]);
    expect(result.current.request.frameIndex).toBe(150);
    expect(lastBakeRequest().text).toBe('Second cue');
  });

  it('carries the trim and indexes the trimmed composition the export writes', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 5, trimStart: 2, trimEnd: 8 }) },
    );
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));

    // The window reaches the conversion, so Rust derives frame_count from it and rebases the cues.
    expect(result.current.request.render.settings).toMatchObject({
      trimStartUs: 2_000_000,
      trimEndUs: 8_000_000,
    });
    // floor((5 - 2) * 30). Untrimmed the same playhead is frame 150, which is the frame the export
    // renders 2 seconds later than the one the user is looking at.
    expect(result.current.request.frameIndex).toBe(90);
    expect(result.current.outsideTrim).toBe(false);
    // The cue is still sent ABSOLUTE. Rebasing it here as well would apply trimStart twice.
    expect(result.current.request.render.lyrics).toEqual([{
      id: 'cue-0-0', startUs: 4_000_000, endUs: 6_000_000, text: 'Second cue',
    }]);
  });

  it('indexes the same wall-clock instant on the same frame at another rate', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 5, trimStart: 2, trimEnd: 8, frameRate: 60 }) },
    );
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));

    expect(result.current.request.frameIndex).toBe(180);
  });

  it('leaves an untrimmed project exactly where it was', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 5 }) },
    );
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));

    expect(result.current.request.frameIndex).toBe(150);
    expect(result.current.request.render.settings).toMatchObject({
      trimStartUs: 0,
      trimEndUs: null,
    });
    expect(result.current.outsideTrim).toBe(false);
  });

  it('renders an instant with nothing on screen rather than refusing it', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 3 }) },
    );
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));

    expect(result.current.request.render.lyrics).toEqual([]);
    expect(lastBakeRequest().text).toBe('');
  });

  it('does not re-bake, re-upload or rebuild the request while the playhead moves inside one cue', async () => {
    const { result, rerender } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 0.5 }) },
    );
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));
    const bakes = bakePreviewAtlas.mock.calls.length;
    const render = result.current.request.render;

    for (const currentTime of [0.6, 0.7, 0.8, 1.9]) {
      // A fresh array every render, exactly as `getCurrentSubtitles()` hands one over.
      rerender(props({ currentTime, subtitles: SUBTITLES.map((cue) => ({ ...cue })) }));
    }

    expect(bakePreviewAtlas.mock.calls.length).toBe(bakes);
    expect(stageGlyphAtlas).toHaveBeenCalledTimes(1);
    // Identity, not just content: the transport keys a new native render on it, so a request rebuilt
    // on every render would re-request every frame the playhead passes through.
    expect(result.current.request.render).toBe(render);
    expect(result.current.request.frameIndex).toBe(57);
  });

  it('re-bakes when the style the baker owns changes', async () => {
    const { result, rerender } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props() },
    );
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));

    rerender(props({ customization: customization({ maxWidth: 50 }) }));
    await waitFor(() => expect(lastBakeRequest().maxWidthPx).toBe(960));
  });

  it('carries the whole customization and the crop into the export request builder', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      {
        initialProps: props({
          customization: customization({ textColor: '#ff0000' }),
          crop: {
            x: 0, y: 0, width: 50, height: 25, aspectRatio: null,
            canvasBgMode: 'solid', canvasBgColor: '#123456', canvasBgBlur: 24, flipX: true, flipY: false,
          },
        }),
      },
    );
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));

    const { render, composition } = result.current.request;
    expect(render.customization.textColor).toBe('#ff0000');
    expect(render.crop).toMatchObject({ width: 50, height: 25, canvasBgColor: '#123456', flipX: true });
    // The composition follows the crop, exactly as the conversion derives it.
    expect(composition).toEqual({ widthPx: 3_840, heightPx: 1_080 });
  });
});

/**
 * The decision about a playhead the export does not cover.
 *
 * The frame index is not clamped to frame 0 or to the last frame, because both of those are real
 * exported frames and putting one on screen at an instant it is not the frame for is precisely the
 * silent substitution this migration removes. No request is made, and the state is REPORTED, so the
 * surface can take the composited frame off rather than hold the last one it decoded.
 */
describe('a playhead outside the trim window', () => {
  const trimmed = (currentTime) => props({ currentTime, trimStart: 2, trimEnd: 8 });

  it('asks for no frame before the trim start', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: trimmed(1) },
    );
    // The atlas still bakes and stages: dormancy is a state of the request, not of the text.
    await waitFor(() => expect(stageGlyphAtlas).toHaveBeenCalledTimes(1));

    expect(result.current).toEqual({ request: null, error: null, outsideTrim: true });
  });

  it('asks for no frame after the trim end', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: trimmed(9) },
    );
    await waitFor(() => expect(stageGlyphAtlas).toHaveBeenCalledTimes(1));

    expect(result.current).toEqual({ request: null, error: null, outsideTrim: true });
  });

  it('comes back the moment the playhead re-enters the window', async () => {
    const { result, rerender } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: trimmed(1) },
    );
    await waitFor(() => expect(result.current.outsideTrim).toBe(true));

    rerender(trimmed(2));
    await waitFor(() => expect(stagedAtlas(result)).toBe(ATLAS));
    expect(result.current.request.frameIndex).toBe(0);
    expect(result.current.outsideTrim).toBe(false);
  });

  it('is not reported on a surface that is not being judged', () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ currentTime: 1, trimStart: 2, trimEnd: 8, active: false }) },
    );
    expect(result.current).toEqual({ request: null, error: null, outsideTrim: false });
  });
});

describe('dormancy and refusal are different states', () => {
  it('is dormant, not failed, before the source has decoded a size', () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ sourceWidthPx: null, sourceHeightPx: null }) },
    );
    expect(result.current).toEqual({ request: null, error: null, outsideTrim: false });
    expect(bakePreviewAtlas).not.toHaveBeenCalled();
  });

  it('is dormant, not failed, before the source asset and project have resolved', async () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ sourceAsset: null, projectId: null }) },
    );
    // The atlas is baked and staged all the same — dormancy is a state of the request, not a reason
    // to leave the text unbaked — but nothing may be asked of the compositor without a binding.
    await waitFor(() => expect(stageGlyphAtlas).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({ request: null, error: null, outsideTrim: false });
  });

  it('is dormant when the face has no verified byte source, rather than substituting one', () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ customization: customization({ fontFamily: 'Nonexistent Display' }) }) },
    );
    expect(result.current.request).toBeNull();
    expect(bakePreviewAtlas).not.toHaveBeenCalled();
  });

  it('is dormant while this surface is not the one being judged', () => {
    const { result } = renderHook(
      (hookProps) => useNativePreviewRequest(hookProps),
      { initialProps: props({ active: false }) },
    );
    expect(result.current.request).toBeNull();
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
    expect(result.current.request).toBeNull();
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
