import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Generic per-engine ASR options for the processing modal — segmentation (strategy / max chars /
 * max words / preserve sentences / max duration) plus an optional forced language. Persisted under
 * `asr_<engineId>_*`. Replaces the Parakeet-specific useParakeetOptions and works for every local ASR
 * engine (Parakeet + the catalog engines).
 *
 * Options are keyed per engine and reload when the active engine changes, so each engine remembers its
 * own settings. For 'nvidia-parakeet' the values seed forward (one-time) from the legacy `parakeet_*`
 * keys so existing users keep their saved settings; the legacy keys are never deleted.
 *
 * @param {string} engineId active ASR engine id ('nvidia-parakeet' | catalog id)
 * @param {{ hasLanguagesBadges?: boolean, defaultStrategy?: string }} opts
 */
const legacyKeyFor = (engineId, suffix) =>
  (engineId === 'nvidia-parakeet' ? `parakeet_${suffix}` : null);

// Read an option, falling back to the legacy parakeet_* key (seed-forward) then a default.
const readOpt = (engineId, suffix, fallback) => {
  const v = localStorage.getItem(`asr_${engineId}_${suffix}`);
  if (v !== null) return v;
  const legacy = legacyKeyFor(engineId, suffix);
  if (legacy) {
    const lv = localStorage.getItem(legacy);
    if (lv !== null) return lv;
  }
  return fallback;
};

const clampInt = (raw, lo, hi, def) => {
  const n = parseInt(raw, 10);
  return Math.min(hi, Math.max(lo, Number.isNaN(n) ? def : n));
};

const loadFor = (engineId, defaultStrategy) => ({
  engineId,
  strategy: readOpt(engineId, 'segment_strategy', defaultStrategy),
  maxChars: clampInt(readOpt(engineId, 'max_chars', '60'), 5, 100, 60),
  maxWords: clampInt(readOpt(engineId, 'max_words', '7'), 1, 50, 7),
  preserveSentences: readOpt(engineId, 'preserve_sentences', 'false') === 'true',
  maxDurationPerRequest: clampInt(readOpt(engineId, 'max_duration_per_request', '3'), 1, 10, 3),
  language: readOpt(engineId, 'language', 'auto'),
});

const useAsrOptions = (engineId, { hasLanguagesBadges = false, defaultStrategy = 'sentence' } = {}) => {
  // Drag-to-scroll for the supported-languages badge strip (engines that show it, i.e. Parakeet).
  const languagesRef = useRef(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startScrollLeftRef = useRef(0);

  const handleMouseDown = useCallback((e) => {
    if (!languagesRef.current || e.button !== 0) return;
    isDraggingRef.current = true;
    languagesRef.current.classList.add('dragging');
    startXRef.current = e.pageX;
    startScrollLeftRef.current = languagesRef.current.scrollLeft;
    e.preventDefault();
  }, []);
  const handleMouseMove = useCallback((e) => {
    if (!isDraggingRef.current || !languagesRef.current) return;
    e.preventDefault();
    languagesRef.current.scrollLeft = startScrollLeftRef.current - (e.pageX - startXRef.current);
  }, []);
  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    if (languagesRef.current) languagesRef.current.classList.remove('dragging');
  }, []);

  useEffect(() => {
    if (!hasLanguagesBadges || !languagesRef.current) return undefined;
    const container = languagesRef.current;
    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [hasLanguagesBadges, handleMouseDown, handleMouseMove, handleMouseUp]);

  // Engine-keyed option state. `opts.engineId` tags which engine the values belong to, so we never
  // persist one engine's values under another's key mid-switch.
  const [opts, setOpts] = useState(() => loadFor(engineId, defaultStrategy));

  // Reload when the active engine changes.
  useEffect(() => {
    if (opts.engineId === engineId) return;
    setOpts(loadFor(engineId, defaultStrategy));
  }, [engineId, defaultStrategy, opts.engineId]);

  // Persist — only once the loaded state matches the active engine (skip the mid-switch render).
  useEffect(() => {
    if (opts.engineId !== engineId) return;
    localStorage.setItem(`asr_${engineId}_segment_strategy`, opts.strategy);
    localStorage.setItem(`asr_${engineId}_max_chars`, String(opts.maxChars));
    localStorage.setItem(`asr_${engineId}_max_words`, String(opts.maxWords));
    localStorage.setItem(`asr_${engineId}_preserve_sentences`, opts.preserveSentences ? 'true' : 'false');
    localStorage.setItem(`asr_${engineId}_max_duration_per_request`, String(opts.maxDurationPerRequest));
    localStorage.setItem(`asr_${engineId}_language`, opts.language);
  }, [engineId, opts]);

  const patch = useCallback((field) => (value) => setOpts((o) => ({ ...o, [field]: value })), []);

  return {
    languagesRef,
    strategy: opts.strategy,
    setStrategy: patch('strategy'),
    maxChars: opts.maxChars,
    setMaxChars: patch('maxChars'),
    maxWords: opts.maxWords,
    setMaxWords: patch('maxWords'),
    preserveSentences: opts.preserveSentences,
    setPreserveSentences: patch('preserveSentences'),
    maxDurationPerRequest: opts.maxDurationPerRequest,
    setMaxDurationPerRequest: patch('maxDurationPerRequest'),
    language: opts.language,
    setLanguage: patch('language'),
  };
};

export default useAsrOptions;
