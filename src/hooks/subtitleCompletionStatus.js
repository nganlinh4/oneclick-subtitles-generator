export const subtitleCompletionStatus = (subtitles, t, { speechOnly = false } = {}) => {
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    if (!speechOnly) {
      return {
        message: t(
          'output.emptyGenerationResult',
          'No result was returned for the selected prompt. Try again or choose another model.'
        ),
        type: 'error',
      };
    }
    return {
      message: t(
        'output.noSubtitlesDetected',
        'No subtitles were returned. The media may contain no detectable speech; otherwise, try again or choose another model.'
      ),
      type: 'warning',
    };
  }
  return { message: t('output.generationSuccess'), type: 'success' };
};
