// Canvas preview: CSS box, face resolution, atlas reuse and retry of refused bakes.
import { act, render, waitFor } from '@testing-library/react';
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import { FONT_READINESS_EVENT } from '../../../services/fontCapability';
import { MANAGED_FONT_PACKAGE } from '../../../services/fontIdentity';
import { defaultCustomization } from '../../subtitleCustomization/defaultCustomization';
import CanvasVideoPreview from './CanvasVideoPreview';
import {
  canvasPreviewMocks,
  resetCanvasPreviewMocks,
  installReadyManagedFont,
  spoofWindowsChrome,
} from './canvasVideoPreviewTestFixtures';

const {
  bakePreviewAtlas,
  createAtlasCanvas,
  drawFrame,
  exactSystemProbe,
  previewFace,
} = canvasPreviewMocks;

vi.mock('../../../platform/systemFontProbe', async () => {
  const { canvasPreviewMocks } = await import('./canvasVideoPreviewTestFixtures');
  return { systemFontProbe: () => canvasPreviewMocks.exactSystemProbe };
});

vi.mock('../native/nativePreviewScene', async (importOriginal) => {
  const { canvasPreviewMocks } = await import('./canvasVideoPreviewTestFixtures');
  return {
    ...(await importOriginal()),
    bakePreviewAtlas: canvasPreviewMocks.bakePreviewAtlas,
    previewFace: canvasPreviewMocks.previewFace,
  };
});

vi.mock('../native/useNativePreviewSource', () => ({
  useVideoSourceDimensions: () => ({ widthPx: 640, heightPx: 360 }),
}));

vi.mock('./canvasSubtitleRenderer', async () => {
  const { canvasPreviewMocks } = await import('./canvasVideoPreviewTestFixtures');
  return {
    createAtlasCanvas: canvasPreviewMocks.createAtlasCanvas,
    createCanvasSubtitleRenderer: canvasPreviewMocks.createCanvasSubtitleRenderer,
  };
});

afterEach(resetCanvasPreviewMocks);

describe('canvas preview scene, fonts and atlas cache', () => {
  it('preserves the authored composition aspect ratio when its element box changes', () => {
    const { container } = render(
      <CanvasVideoPreview
        active={false}
        videoRef={{ current: null }}
        sourceKey="fixture"
        customization={defaultCustomization}
        subtitles={[]}
        resolution={{ width: 1920, height: 1080 }}
      />,
    );
    const canvas = container.querySelector('canvas');
    expect(canvas.style.objectFit).toBe('contain');
    expect(canvas.style.backgroundColor).toBe('rgb(0, 0, 0)');
  });

  it('re-resolves the preview face when native font readiness advances', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 jsdom');
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'repairing',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: null,
    };
    render(
      <CanvasVideoPreview
        videoRef={{ current: null }}
        sourceKey="font-readiness-transition"
        customization={defaultCustomization}
        subtitles={[]}
        resolution="1080p"
      />,
    );
    expect(previewFace).toHaveBeenLastCalledWith(expect.objectContaining({
      capability: expect.objectContaining({ epoch: 1, managedPackInstalled: false }),
      isSystemFaceInstalled: exactSystemProbe,
    }));

    act(() => {
      window.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
        detail: {
          schema: 1,
          state: 'ready',
          family: MANAGED_FONT_PACKAGE.family,
          epoch: 2,
          reason: null,
          retryable: false,
          version: MANAGED_FONT_PACKAGE.version,
        },
      }));
    });
    await waitFor(() => expect(previewFace).toHaveBeenLastCalledWith(expect.objectContaining({
      capability: expect.objectContaining({ epoch: 2, managedPackInstalled: true }),
      isSystemFaceInstalled: exactSystemProbe,
    })));
  });

  it('publishes managed font preparation as a typed prerequisite and wakes when readiness advances', async () => {
    spoofWindowsChrome();
    window.__OSG_FONT_READINESS__ = {
      schema: 1,
      state: 'repairing',
      family: MANAGED_FONT_PACKAGE.family,
      epoch: 1,
      reason: null,
      retryable: false,
      version: null,
    };
    const onStateChange = vi.fn();
    render(
      <CanvasVideoPreview
        videoRef={{ current: { currentTime: 0.5, seeking: false } }}
        sourceKey="managed-font-prerequisite"
        customization={defaultCustomization}
        subtitles={[{ start: 0, end: 1, text: 'Wait for verified bytes' }]}
        resolution="1080p"
        onStateChange={onStateChange}
      />,
    );

    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({
      status: 'font-blocked', code: null,
    }));
    expect(bakePreviewAtlas).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
        detail: {
          schema: 1,
          state: 'ready',
          family: MANAGED_FONT_PACKAGE.family,
          epoch: 2,
          reason: null,
          retryable: false,
          version: MANAGED_FONT_PACKAGE.version,
        },
      }));
    });
    await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({ status: 'ready', code: null }));
  });

  it('repaints but retains one atlas across paint, position, timing and cue-index changes', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    const videoRef = { current: { currentTime: 0.5, seeking: false } };
    const props = {
      videoRef,
      sourceKey: 'atlas-partition',
      customization: defaultCustomization,
      subtitles: [{ start: 0, end: 1, text: 'Same shaped text' }],
      resolution: '1080p',
    };
    const { container, rerender } = render(<CanvasVideoPreview {...props} />);
    await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(1));

    const drawsBeforePaint = drawFrame.mock.calls.length;
    rerender(<CanvasVideoPreview
      {...props}
      customization={{ ...defaultCustomization, textColor: '#00ff00' }}
    />);
    await waitFor(() => expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforePaint));

    const drawsBeforeTiming = drawFrame.mock.calls.length;
    rerender(<CanvasVideoPreview
      {...props}
      customization={{ ...defaultCustomization, position: 'top', fadeInDuration: 0.1 }}
      subtitles={[
        { start: 0, end: 0.1, text: 'Different inactive text' },
        { start: 0.2, end: 1.25, text: 'Same shaped text' },
      ]}
    />);
    await waitFor(() => {
      expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforeTiming);
      expect(container.querySelector('canvas')?.dataset.osgCueIndex).toBe('1');
    });
    expect(bakePreviewAtlas).toHaveBeenCalledTimes(1);

    const changedCrop = {
      x: 1,
      y: 1,
      width: 100,
      height: 100,
      aspectRatio: null,
      canvasBgMode: 'solid',
      canvasBgColor: '#102030',
      canvasBgBlur: 24,
      flipX: true,
      flipY: false,
    };
    const drawsBeforeCrop = drawFrame.mock.calls.length;
    rerender(<CanvasVideoPreview {...props} crop={changedCrop} />);
    await waitFor(() => expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforeCrop));
    expect(drawFrame.mock.calls.at(-1)[0].crop).toEqual(changedCrop);
    expect(bakePreviewAtlas).toHaveBeenCalledTimes(1);

    const drawsBeforeTrim = drawFrame.mock.calls.length;
    rerender(<CanvasVideoPreview {...props} trimStart={0.75} />);
    await waitFor(() => expect(drawFrame.mock.calls.length).toBeGreaterThan(drawsBeforeTrim));
    expect(bakePreviewAtlas).toHaveBeenCalledTimes(1);

    rerender(<CanvasVideoPreview
      {...props}
      customization={{ ...defaultCustomization, fontSize: defaultCustomization.fontSize + 1 }}
    />);
    await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(2));
  });

  it('keeps a speculative next-cue bake refusal silent until that cue is active', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    const originalBake = bakePreviewAtlas.getMockImplementation();
    bakePreviewAtlas.mockImplementation((bake) => {
      if (bake.request.text === 'The next cue cannot bake') {
        throw Object.assign(new Error('next cue refused'), { code: 'nextCueRejected' });
      }
      return { layout: { lines: [] } };
    });
    const states = [];
    const video = { currentTime: 0.5, seeking: false };
    const props = {
      videoRef: { current: video },
      sourceKey: 'prefetch-refusal-ownership',
      customization: defaultCustomization,
      subtitles: [
        { start: 0, end: 1, text: 'The visible cue is valid' },
        { start: 2, end: 3, text: 'The next cue cannot bake' },
      ],
      resolution: '1080p',
      currentTime: 0.5,
      onStateChange: state => states.push(state),
    };

    try {
      const { rerender } = render(<CanvasVideoPreview {...props} />);
      await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(states.at(-1)).toEqual({ status: 'ready', code: null }));
      expect(states).not.toContainEqual({ status: 'error', code: 'nextCueRejected' });

      video.currentTime = 2.5;
      rerender(<CanvasVideoPreview {...props} currentTime={2.5} />);
      await waitFor(() => expect(states.at(-1)).toEqual({
        status: 'error',
        code: 'nextCueRejected',
        retryable: false,
      }));
    } finally {
      bakePreviewAtlas.mockImplementation(originalBake);
    }
  });

  it('retries only a transient canvas allocation failure when the surface requests it', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    createAtlasCanvas.mockImplementationOnce(() => {
      throw new Error('canvasPreviewUnavailable');
    });
    const onStateChange = vi.fn();
    const videoRef = { current: { currentTime: 0.5, seeking: false } };
    const props = {
      videoRef,
      sourceKey: 'retryable-canvas',
      customization: defaultCustomization,
      subtitles: [{ start: 0, end: 1, text: 'Retry me once' }],
      resolution: '1080p',
      onStateChange,
      retryToken: 0,
    };
    const { rerender } = render(<CanvasVideoPreview {...props} />);

    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({
      status: 'error', code: 'canvasPreviewUnavailable', retryable: true,
    }));
    expect(bakePreviewAtlas).toHaveBeenCalledTimes(1);

    rerender(<CanvasVideoPreview {...props} retryToken={1} />);
    await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({ status: 'ready', code: null }));
  });

  it('automatically retries a face-loading race when FontFaceSet activates the verified face', async () => {
    spoofWindowsChrome();
    installReadyManagedFont();
    const priorFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    const fontEvents = new EventTarget();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fontEvents });
    const unavailable = Object.assign(new Error('glyphAtlasFaceLoading'), {
      code: 'glyphAtlasFaceLoading',
    });
    bakePreviewAtlas.mockImplementationOnce(() => { throw unavailable; });
    const onStateChange = vi.fn();

    try {
      render(
        <CanvasVideoPreview
          videoRef={{ current: { currentTime: 0.5, seeking: false } }}
          sourceKey="font-face-loading-race"
          customization={defaultCustomization}
          subtitles={[{ start: 0, end: 1, text: 'Loaded after mount' }]}
          resolution="1080p"
          onStateChange={onStateChange}
        />,
      );
      await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({
        status: 'error', code: 'glyphAtlasFaceLoading', retryable: true,
      }));

      act(() => fontEvents.dispatchEvent(new Event('loadingdone')));
      await waitFor(() => expect(bakePreviewAtlas).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(onStateChange).toHaveBeenCalledWith({ status: 'ready', code: null }));
    } finally {
      if (priorFonts === undefined) delete document.fonts;
      else Object.defineProperty(document, 'fonts', priorFonts);
    }
  });
});
