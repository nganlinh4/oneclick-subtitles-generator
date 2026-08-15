import { useMemo, useState, useEffect } from 'react';
import { autoSplitSubtitle, countWords } from '../../../utils/subtitle/splitUtils';

const readInitialLimit = () => {
  try {
    const saved = localStorage.getItem('translation_post_split_max_words');
    const parsed = /^(0|[1-9]\d*)$/.test(saved ?? '') ? Number(saved) : 31;
    if (!Number.isFinite(parsed) || parsed === 0) return 31;
    return Math.min(31, Math.max(1, parsed));
  } catch {
    return 31;
  }
};

/**
 * Compute a presentation-only post-split view. The durable base translation is never replaced.
 */
const usePostSplitSubtitles = ({ translatedSubtitles }) => {
  const [postSplitMaxWords, setPostSplitMaxWords] = useState(readInitialLimit);

  useEffect(() => {
    try {
      localStorage.setItem('translation_post_split_max_words', String(postSplitMaxWords));
    } catch {
      // This display preference is best-effort.
    }
  }, [postSplitMaxWords]);

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
