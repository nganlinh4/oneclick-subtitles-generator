import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isDesktopRuntime } from '../../platform/desktopRuntime';
import { exportMediaAsset } from '../../platform/mediaExportService';
import {
  buildNativeRenderRequest,
  ensureNativeRenderProject,
  releaseNativeRenderPlayback,
  resolveNativeRenderSource,
  runNativeRender,
} from '../../platform/renderService';
import { downloadVideo, renderSubtitlesToVideo } from '../../utils/videoUtils';
import { stageNativeRenderText } from './native/exportTextStaging';
import {
  createDownloadWithSubtitlesHandler,
  normalizePreviewRenderLyrics,
  previewCustomizationForNativeRender,
  renderAndExportDesktopPreview,
} from './videoDownloadHandlers';
import { DEFAULT_SUBTITLE_FONT_FAMILY } from '../../shared/subtitle/defaultSubtitleFont';

vi.mock('../../platform/desktopRuntime', () => ({ isDesktopRuntime: vi.fn() }));
vi.mock('./native/exportTextStaging', () => ({ stageNativeRenderText: vi.fn() }));
vi.mock('../../platform/mediaExportService', () => ({ exportMediaAsset: vi.fn() }));
vi.mock('../../platform/renderService', () => ({
  buildNativeRenderRequest: vi.fn(),
  ensureNativeRenderProject: vi.fn(),
  releaseNativeRenderPlayback: vi.fn(),
  resolveNativeRenderSource: vi.fn(),
  runNativeRender: vi.fn(),
}));
vi.mock('../../utils/videoUtils', () => ({
  downloadVideo: vi.fn(),
  renderSubtitlesToVideo: vi.fn(),
}));

const sourceAsset = Object.freeze({
  id: '019ffbea-26d5-7800-8e3b-69de8bff2d7d',
  displayName: 'fixture.mp4',
  extension: 'mp4',
  sizeBytes: 1024,
  kind: 'video',
});

describe('desktop preview subtitle rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDesktopRuntime.mockReturnValue(true);
    resolveNativeRenderSource.mockResolvedValue(sourceAsset);
    ensureNativeRenderProject.mockResolvedValue('019ffbea-40eb-7c3c-b2f3-214ca260a7cc');
    buildNativeRenderRequest.mockReturnValue(Object.freeze({ native: true }));
    stageNativeRenderText.mockResolvedValue(Object.freeze({ schemaVersion: 1, staged: true }));
    runNativeRender.mockImplementation(async (_request, handlers) => {
      handlers.onProgress({ fractionMillionths: 250_000 });
      return {
        result: {
          asset: { id: '019ffbea-50eb-7c3c-b2f3-214ca260a7cc' },
          playback: { id: '7e63a5f8-7277-45ee-a834-9fe1456aef5d' },
        },
      };
    });
    exportMediaAsset.mockResolvedValue(true);
    releaseNativeRenderPlayback.mockResolvedValue(true);
  });

  it('normalizes legacy timestamp shapes before the native request', () => {
    expect(normalizePreviewRenderLyrics([
      { id: 'first', startTime: '00:00:01,250', endTime: '00:00:02,500', text: 'One' },
      { subtitle_id: 'second', start: 3, end: 4.25, text: 'Two' },
    ])).toEqual([
      { id: 'first', start: 1.25, end: 2.5, text: 'One' },
      { id: 'second', start: 3, end: 4.25, text: 'Two' },
    ]);
  });

  it('maps preview styling onto the complete native customization contract', () => {
    const customization = previewCustomizationForNativeRender({
      fontSize: '36',
      fontWeight: '700',
      lineSpacing: '1.5',
      opacity: '0.65',
      position: '82',
      boxWidth: '72',
      textShadow: 'true',
      textAlign: 'right',
      textTransform: 'uppercase',
    });
    expect(customization).toMatchObject({
      fontSize: 36,
      fontWeight: 700,
      lineHeight: 1.5,
      backgroundOpacity: 65,
      position: 'custom',
      customPositionX: 50,
      customPositionY: 82,
      maxWidth: 72,
      textShadowEnabled: true,
      textAlign: 'right',
      textTransform: 'uppercase',
    });
    expect(Object.keys(customization).length).toBeGreaterThan(40);
  });

  it('repairs corrupt persisted styling to values accepted by the native render contract', () => {
    const customization = previewCustomizationForNativeRender({
      fontFamily: `private\u0000font-${'x'.repeat(300)}`,
      fontWeight: 555,
      lineSpacing: 99,
      letterSpacing: -101,
      textColor: 'red',
      backgroundColor: 'transparent',
    });

    expect(customization).toMatchObject({
      fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
      fontWeight: 400,
      lineHeight: 1.2,
      letterSpacing: 0,
      textColor: '#ffffff',
      backgroundColor: '#000000',
    });
  });

  it('renders, exports, reports progress, and releases native playback', async () => {
    const onProgress = vi.fn();
    await expect(renderAndExportDesktopPreview({
      videoUrl: 'http://127.0.0.1/native-media',
      videoSource: null,
      subtitles: [{ start: 0, end: 1, text: 'Hello' }],
      subtitleSettings: {},
      onProgress,
    })).resolves.toBe(true);

    expect(resolveNativeRenderSource).toHaveBeenCalledWith('http://127.0.0.1/native-media');
    expect(buildNativeRenderRequest).toHaveBeenCalledWith(expect.objectContaining({
      sourceAsset,
      projectId: '019ffbea-40eb-7c3c-b2f3-214ca260a7cc',
      lyrics: [{ id: 0, start: 0, end: 1, text: 'Hello' }],
      settings: expect.objectContaining({
        originalAudioVolume: 100,
        narrationVolume: 0,
      }),
      customization: expect.objectContaining({
        fontWeight: 400,
        textColor: '#ffffff',
        backgroundColor: '#000000',
      }),
    }));
    // The glyphs travel with the request: an export the WebView did not stage text for is refused
    // natively rather than drawn with an atlas nobody chose.
    expect(stageNativeRenderText).toHaveBeenCalledWith(
      { native: true },
      { source: 'http://127.0.0.1/native-media' },
    );
    expect(runNativeRender).toHaveBeenCalledWith(
      { native: true },
      expect.objectContaining({ text: { schemaVersion: 1, staged: true } }),
    );
    expect(onProgress).toHaveBeenCalledWith(0.25);
    expect(exportMediaAsset).toHaveBeenCalledWith('019ffbea-50eb-7c3c-b2f3-214ca260a7cc');
    expect(releaseNativeRenderPlayback).toHaveBeenCalledWith(
      '7e63a5f8-7277-45ee-a834-9fe1456aef5d'
    );
  });

  it('releases playback when the user-facing export fails', async () => {
    exportMediaAsset.mockRejectedValueOnce(new Error('save failed'));
    await expect(renderAndExportDesktopPreview({
      videoUrl: 'http://127.0.0.1/native-media',
      subtitles: [{ start: 0, end: 1, text: 'Hello' }],
      subtitleSettings: {},
      onProgress: vi.fn(),
    })).rejects.toThrow('save failed');
    expect(releaseNativeRenderPlayback).toHaveBeenCalledOnce();
  });

  it('uses the native renderer from the visible preview action and never records a WebM', async () => {
    const setRenderProgress = vi.fn();
    const setError = vi.fn();
    const setIsRenderingVideo = vi.fn();
    const handler = createDownloadWithSubtitlesHandler({
      videoUrl: 'http://127.0.0.1/native-media',
      subtitlesArray: [{ start: 0, end: 1, text: 'Hello' }],
      subtitleSettings: {},
      videoSource: { title: 'Fixture' },
      t: (_key, fallback) => fallback,
      setError,
      setIsRenderingVideo,
      setRenderProgress,
    });

    await handler();

    expect(runNativeRender).toHaveBeenCalledOnce();
    expect(renderSubtitlesToVideo).not.toHaveBeenCalled();
    expect(downloadVideo).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('');
    expect(setIsRenderingVideo).toHaveBeenNthCalledWith(1, true);
    expect(setIsRenderingVideo).toHaveBeenLastCalledWith(false);
  });

  it('preserves the existing browser renderer and download path outside Tauri', async () => {
    isDesktopRuntime.mockReturnValue(false);
    renderSubtitlesToVideo.mockResolvedValue('blob:browser-render');
    const handler = createDownloadWithSubtitlesHandler({
      videoUrl: 'https://example.test/video.mp4',
      subtitlesArray: [{ start: 0, end: 1, text: 'Hello' }],
      subtitleSettings: {},
      videoSource: { title: 'Fixture' },
      t: (_key, fallback) => fallback,
      setError: vi.fn(),
      setIsRenderingVideo: vi.fn(),
      setRenderProgress: vi.fn(),
    });

    await handler();

    expect(renderSubtitlesToVideo).toHaveBeenCalledOnce();
    expect(downloadVideo).toHaveBeenCalledWith(
      'blob:browser-render',
      'Fixture.webm'
    );
    expect(runNativeRender).not.toHaveBeenCalled();
  });
});
