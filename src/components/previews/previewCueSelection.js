import { convertTimeStringToSeconds } from '../../utils/vttUtils';

/** The editor preview's fixed composition resolution. Export owns its independent project setting. */
export const EDITOR_PREVIEW_RESOLUTION = '1080p';

/**
 * Select translated text on the original cue's timing.
 *
 * Preview, video export, and subtitle downloads share this mapping. The original cue owns both
 * timing and speaker presentation, including an explicitly removed speaker.
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
          speaker: original.speaker,
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
      speaker: subtitle.speaker,
    };
  })
);
