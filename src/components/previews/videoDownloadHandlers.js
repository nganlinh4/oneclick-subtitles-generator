import { renderSubtitlesToVideo, downloadVideo } from '../../utils/videoUtils';
import { convertTimeStringToSeconds } from '../../utils/vttUtils';
import { defaultCustomization } from '../subtitleCustomization/defaultCustomization';
import { isDesktopRuntime } from '../../platform/desktopRuntime';
import { exportMediaAsset } from '../../platform/mediaExportService';
import {
  buildNativeRenderRequest,
  ensureNativeRenderProject,
  releaseNativeRenderPlayback,
  resolveNativeRenderSource,
  runNativeRender,
} from '../../platform/renderService';
import { stageNativeRenderText } from './native/exportTextStaging';

const boundedNumber = (value, fallback, minimum, maximum) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : fallback;
};

const validNativeColor = (value, fallback) => (
  typeof value === 'string'
    && /^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i.test(value)
    ? value
    : fallback
);

const validNativeFontFamily = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return defaultCustomization.fontFamily;
  }
  const encoded = new TextEncoder().encode(value);
  return encoded.byteLength <= 256 && !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  }) ? value : defaultCustomization.fontFamily;
};

const validNativeFontWeight = (value) => {
  const numeric = Number(value);
  return Number.isInteger(numeric)
    && numeric >= 100
    && numeric <= 900
    && numeric % 100 === 0
    ? numeric
    : defaultCustomization.fontWeight;
};

const subtitleTime = (value) => (
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : convertTimeStringToSeconds(value)
);

export const normalizePreviewRenderLyrics = (subtitles) => subtitles.map((subtitle, index) => ({
  id: subtitle?.id ?? subtitle?.subtitle_id ?? index,
  start: subtitleTime(subtitle?.start ?? subtitle?.start_time ?? subtitle?.startTime),
  end: subtitleTime(subtitle?.end ?? subtitle?.end_time ?? subtitle?.endTime),
  text: String(subtitle?.text ?? ''),
}));

/**
 * The output settings the editor preview composes and downloads at.
 *
 * The editor has no render-settings UI, so these are the values its download handler has always
 * used. They are named and exported rather than left inline because the native preview surface has
 * to compose at exactly the same size and frame grid as the file this handler writes; two literals
 * that happened to agree would be the next thing to drift.
 */
export const EDITOR_PREVIEW_RESOLUTION = '1080p';
export const EDITOR_PREVIEW_FRAME_RATE = 30;

/**
 * The translated cue list as the export composes it: translated text on the ORIGINAL cue's timing.
 *
 * A translation carries the text and, when the translator produced one, an `originalId` naming the
 * cue it came from — but its own timing is frequently absent or in the string form the editor uses
 * elsewhere. Resolving that is not a detail of downloading; it decides which words are on screen at
 * which instant, so the preview asks this same function rather than composing the raw translation at
 * whatever timings it happens to carry. Two answers to that question is how a preview and its export
 * disagree while both look correct.
 */
export const translatedSubtitlesForRender = (translatedSubtitles, subtitlesArray) => (
  translatedSubtitles.map((sub) => {
    // A translation that names its original is timed by that original, whatever it carries itself.
    if (sub.originalId && subtitlesArray) {
      const originalSub = subtitlesArray.find((s) => s.id === sub.originalId);
      if (originalSub) {
        return {
          id: sub.id,
          start: originalSub.start,
          end: originalSub.end,
          text: sub.text,
        };
      }
    }

    if (sub.start !== undefined && sub.end !== undefined) {
      return sub;
    }

    return {
      id: sub.id,
      start: typeof sub.startTime === 'string' ? convertTimeStringToSeconds(sub.startTime) : 0,
      end: typeof sub.endTime === 'string' ? convertTimeStringToSeconds(sub.endTime) : 0,
      text: sub.text,
    };
  })
);

export const previewCustomizationForNativeRender = (settings = {}) => {
  const position = boundedNumber(settings.position, 90, 0, 100);
  const textAlign = ['left', 'center', 'right'].includes(settings.textAlign)
    ? settings.textAlign
    : defaultCustomization.textAlign;
  const textTransform = ['none', 'uppercase', 'lowercase', 'capitalize'].includes(
    settings.textTransform
  ) ? settings.textTransform : defaultCustomization.textTransform;
  return {
    ...defaultCustomization,
    fontSize: boundedNumber(settings.fontSize, defaultCustomization.fontSize, 1, 1_000),
    fontFamily: validNativeFontFamily(settings.fontFamily),
    fontWeight: validNativeFontWeight(settings.fontWeight),
    textColor: validNativeColor(settings.textColor, defaultCustomization.textColor),
    textAlign,
    lineHeight: boundedNumber(
      settings.lineSpacing,
      defaultCustomization.lineHeight,
      0.1,
      10
    ),
    letterSpacing: boundedNumber(
      settings.letterSpacing,
      defaultCustomization.letterSpacing,
      -100,
      1_000
    ),
    textTransform,
    backgroundColor: validNativeColor(
      settings.backgroundColor,
      defaultCustomization.backgroundColor
    ),
    backgroundOpacity: boundedNumber(
      Number(settings.opacity) * 100,
      defaultCustomization.backgroundOpacity,
      0,
      100
    ),
    borderRadius: boundedNumber(
      settings.backgroundRadius,
      defaultCustomization.borderRadius,
      0,
      1_000
    ),
    textShadowEnabled: settings.textShadow === true || settings.textShadow === 'true',
    position: 'custom',
    customPositionX: 50,
    customPositionY: position,
    maxWidth: boundedNumber(settings.boxWidth, defaultCustomization.maxWidth, 1, 100),
  };
};

export const renderAndExportDesktopPreview = async ({
  videoUrl,
  videoSource,
  subtitles,
  subtitleSettings,
  onProgress,
}) => {
  const sourceAsset = await resolveNativeRenderSource(videoUrl || videoSource);
  const request = buildNativeRenderRequest({
    sourceAsset,
    projectId: await ensureNativeRenderProject(sourceAsset),
    lyrics: normalizePreviewRenderLyrics(subtitles),
    settings: {
      resolution: EDITOR_PREVIEW_RESOLUTION,
      frameRate: EDITOR_PREVIEW_FRAME_RATE,
      originalAudioVolume: 100,
      narrationVolume: 0,
      trimStart: 0,
      trimEnd: 0,
    },
    customization: previewCustomizationForNativeRender(subtitleSettings),
    crop: {
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
    },
  });
  // The glyphs this file is drawn with. The export composes them natively but never shapes them, so
  // the atlas and one laid-out run per cue are baked here and travel with the request. A font the
  // editor cannot resolve refuses by name rather than writing a file in a substitute.
  const text = await stageNativeRenderText(request, { source: videoUrl || videoSource });
  const completed = await runNativeRender(request, {
    text,
    onProgress: (event) => onProgress(event.fractionMillionths / 1_000_000),
  });
  try {
    return await exportMediaAsset(completed.result.asset.id);
  } finally {
    await releaseNativeRenderPlayback(completed.result.playback.id).catch(() => undefined);
  }
};

/**
 * Factory helpers for the "download video with burned-in subtitles" actions.
 * Each returns an async handler closing over the parent's state setters/props.
 * Behaviour is moved verbatim from VideoPreview.
 */

/**
 * Build the handler that renders + downloads the video with the original
 * (source-language) subtitles.
 */
export const createDownloadWithSubtitlesHandler = ({
  videoUrl,
  subtitlesArray,
  subtitleSettings,
  videoSource,
  t,
  setError,
  setIsRenderingVideo,
  setRenderProgress,
}) => async () => {
  if (!videoUrl || !subtitlesArray || subtitlesArray.length === 0) {
    setError(t('videoPreview.noSubtitlesToRender', 'No subtitles to render'));
    return;
  }

  setIsRenderingVideo(true);
  setRenderProgress(0);
  setError('');

  try {
    if (isDesktopRuntime()) {
      await renderAndExportDesktopPreview({
        videoUrl,
        videoSource,
        subtitles: subtitlesArray,
        subtitleSettings,
        onProgress: setRenderProgress,
      });
      return;
    }
    const renderedVideoUrl = await renderSubtitlesToVideo(
      videoUrl,
      subtitlesArray,
      subtitleSettings,
      (progress) => setRenderProgress(progress)
    );

    // Get video title or use default
    const videoTitle = videoSource?.title || 'video-with-subtitles';
    downloadVideo(renderedVideoUrl, `${videoTitle}.webm`);
  } catch (err) {
    console.error('Error rendering subtitles:', err);
    setError(t('videoPreview.renderError', 'Error rendering subtitles: {{error}}', { error: err.message }));
  } finally {
    setIsRenderingVideo(false);
  }
};

/**
 * Build the handler that renders + downloads the video with the translated
 * subtitles, reusing original subtitle timings where available.
 */
export const createDownloadWithTranslatedSubtitlesHandler = ({
  videoUrl,
  subtitlesArray,
  translatedSubtitles,
  subtitleSettings,
  videoSource,
  t,
  setError,
  setIsRenderingVideo,
  setRenderProgress,
}) => async () => {
  if (!videoUrl || !translatedSubtitles || translatedSubtitles.length === 0) {
    setError(t('videoPreview.noTranslatedSubtitles', 'No translated subtitles available'));
    return;
  }

  setIsRenderingVideo(true);
  setRenderProgress(0);
  setError('');

  try {
    // The same cue list the editor's preview composes, from the same function.
    const formattedSubtitles = translatedSubtitlesForRender(translatedSubtitles, subtitlesArray);

    if (isDesktopRuntime()) {
      await renderAndExportDesktopPreview({
        videoUrl,
        videoSource,
        subtitles: formattedSubtitles,
        subtitleSettings,
        onProgress: setRenderProgress,
      });
      return;
    }

    const renderedVideoUrl = await renderSubtitlesToVideo(
      videoUrl,
      formattedSubtitles,
      subtitleSettings,
      (progress) => setRenderProgress(progress)
    );

    // Get video title or use default
    const videoTitle = videoSource?.title || 'video-with-translated-subtitles';
    downloadVideo(renderedVideoUrl, `${videoTitle}.webm`);
  } catch (err) {
    console.error('Error rendering translated subtitles:', err);
    setError(t('videoPreview.renderError', 'Error rendering subtitles: {{error}}', { error: err.message }));
  } finally {
    setIsRenderingVideo(false);
  }
};
