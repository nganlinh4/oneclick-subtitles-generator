import { useState, useEffect } from 'react';
import { autoSplitSubtitles, countWords } from '../../../utils/subtitle/splitUtils';

/**
 * Manage the post-split "max words per subtitle" setting and apply it to
 * translated subtitles.
 *
 * Values range 1–30, with 31 meaning "Unlimited". Persists to localStorage.
 *
 * @param {Object} params
 * @param {Array} params.translatedSubtitles - Current translated subtitles
 * @param {Function} params.updateTranslatedSubtitles - Setter for translated subtitles
 * @returns {{ postSplitMaxWords: number, setPostSplitMaxWords: Function }}
 */
const usePostSplitSubtitles = ({ translatedSubtitles, updateTranslatedSubtitles }) => {
  // Post-split translated subtitles (1–30 and Unlimited=31). Default: Unlimited
  const [postSplitMaxWords, setPostSplitMaxWords] = useState(() => {
    const saved = localStorage.getItem('translation_post_split_max_words');
    let num = saved ? parseInt(saved, 10) : 31; // Default Unlimited (31)
    if (!Number.isFinite(num)) num = 31;
    // Migrate legacy 0 (old Unlimited) to 31
    if (num === 0) num = 31;
    // Clamp to [1..31]
    if (num < 1) num = 1;
    if (num > 31) num = 31;
    return num;
  });

  // Persist post-split setting
  useEffect(() => {
    try {
      localStorage.setItem('translation_post_split_max_words', String(postSplitMaxWords));
    } catch {
      // Persistence is best-effort in restricted storage contexts.
    }
  }, [postSplitMaxWords]);

  // Apply post-split to translated subtitles when needed
  useEffect(() => {
    if (!Array.isArray(translatedSubtitles) || translatedSubtitles.length === 0) return;

    const v = Number(postSplitMaxWords);
    if (!Number.isFinite(v) || v >= 31) return; // Unlimited

    const limit = Math.max(1, v);

    // Only split when any subtitle exceeds the limit
    const exceeds = translatedSubtitles.some(s => countWords(s?.text || '') > limit);
    if (!exceeds) return;

    const split = autoSplitSubtitles(translatedSubtitles, limit);
    updateTranslatedSubtitles(split);

    try {
      window.dispatchEvent(new CustomEvent('translation-updated', {
        detail: { translatedSubtitles: split, source: 'post-split' }
      }));
    } catch {
      // Custom events are best-effort in non-browser test environments.
    }
  }, [translatedSubtitles, postSplitMaxWords, updateTranslatedSubtitles]);

  return { postSplitMaxWords, setPostSplitMaxWords };
};

export default usePostSplitSubtitles;
