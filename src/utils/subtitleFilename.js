/**
 * The proposed customer filename for a subtitle document save.
 *
 * Naming priority: the uploaded subtitle document's own name, then the video name, then the video
 * title. A translated save must never propose the same name as the original track: language
 * translations carry the language, and a translation without target languages (the provider-free
 * Format chain) still gets a distinguishing suffix — otherwise saving both tracks as SRT collides
 * on one filename and the second save is refused or clobbers the first.
 */
export const generateSubtitleFilename = ({
  source,
  sourceSubtitleName = '',
  videoName = '',
  videoTitle = '',
  targetLanguages = [],
}) => {
  let baseName = '';
  if (sourceSubtitleName) {
    baseName = sourceSubtitleName.replace(/\.(srt|json)$/i, '');
  } else if (videoName) {
    baseName = videoName.replace(/\.[^/.]+$/, '');
  } else {
    baseName = videoTitle || 'subtitles';
  }

  let langSuffix = '';
  if (source === 'translated') {
    if (targetLanguages.length === 1) {
      const langName = targetLanguages[0].value || targetLanguages[0];
      langSuffix = `_${langName.toLowerCase().replace(/\s+/g, '_')}`;
    } else if (targetLanguages.length > 1) {
      langSuffix = '_multi_lang';
    } else {
      langSuffix = '_translated';
    }
  }

  return `${baseName}${langSuffix}`;
};
