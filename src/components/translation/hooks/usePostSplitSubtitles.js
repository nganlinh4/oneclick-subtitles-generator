import { useMemo } from 'react';
import { autoSplitSubtitle, countWords } from '../../../utils/subtitle/splitUtils';
import { usePreference } from '../../../platform/preferences/store';

/**
 * Compute a presentation-only post-split view. The durable base translation is never replaced.
 */
const usePostSplitSubtitles = ({ translatedSubtitles }) => {
  const [storedMaxWords, setPostSplitMaxWords] = usePreference('translation_post_split_max_words');
  const postSplitMaxWords = storedMaxWords === 0 ? 31 : storedMaxWords;

  const presentedSubtitles = useMemo(() => {
    if (!Array.isArray(translatedSubtitles) || translatedSubtitles.length === 0) {
      return translatedSubtitles;
    }
    const value = Number(postSplitMaxWords);
    if (!Number.isFinite(value) || value >= 31) return translatedSubtitles;
    const limit = Math.max(1, value);
    if (!translatedSubtitles.some((subtitle) => countWords(subtitle?.text || '') > limit)) {
      return translatedSubtitles;
    }
    let presentationOrder = 0;
    const derived = translatedSubtitles.flatMap((base) => (
      autoSplitSubtitle(base, limit).map((subtitle, splitIndex) => {
        presentationOrder += 1;
        return Object.freeze({
          ...subtitle,
          id: `translation-presentation-${presentationOrder}`,
          originalId: base.originalId,
          sourceOrder: base.sourceOrder,
          derivedSplitIndex: splitIndex,
          derivedFromTranslation: true,
        });
      })
    ));
    return Object.freeze(derived);
  }, [postSplitMaxWords, translatedSubtitles]);

  return { postSplitMaxWords, setPostSplitMaxWords, presentedSubtitles };
};

export default usePostSplitSubtitles;
