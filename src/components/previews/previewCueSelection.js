import { convertTimeStringToSeconds } from '../../utils/vttUtils';

/** The editor preview's fixed composition resolution. Export owns its independent project setting. */
export const EDITOR_PREVIEW_RESOLUTION = '1080p';

/**
 * Select translated text on the original cue's timing.
 *
 * This is a preview decision, not an export action. The render tab consumes the same project-owned
 * subtitle source independently; keeping only the cue mapping here avoids resurrecting the deleted
 * browser-era "download from the preview" renderer.
 */
export const translatedSubtitlesForRender = (translatedSubtitles, subtitlesArray) => (
  translatedSubtitles.map((subtitle) => {
    if (subtitle.originalId && subtitlesArray) {
      const original = subtitlesArray.find((candidate) => candidate.id === subtitle.originalId);
      if (original) {
        return {
          id: subtitle.id,
          start: original.start,
          end: original.end,
          text: subtitle.text,
        };
      }
    }

    if (subtitle.start !== undefined && subtitle.end !== undefined) return subtitle;
    return {
      id: subtitle.id,
      start: typeof subtitle.startTime === 'string'
        ? convertTimeStringToSeconds(subtitle.startTime)
        : 0,
      end: typeof subtitle.endTime === 'string'
        ? convertTimeStringToSeconds(subtitle.endTime)
        : 0,
      text: subtitle.text,
    };
  })
);
