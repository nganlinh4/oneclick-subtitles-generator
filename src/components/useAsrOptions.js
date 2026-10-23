import { useState, useRef, useEffect, useCallback } from 'react';
import { normalizeAsrLanguage } from '../services/engines/asrEngines';
import { hasStoredPreference, readPreference, writePreference } from '../platform/preferences/store';

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
const optionKey = (engineId, option) => `asr_${engineId}_${option}`;

// The engine's own value, else Parakeet's legacy parakeet_* value (seed-forward), else the default.
const readOpt = (engineId, option) => {
  const key = optionKey(engineId, option);
  if (hasStoredPreference(key) || engineId !== 'nvidia-parakeet') return readPreference(key);
  const legacy = `parakeet_${option}`;
  return readPreference(hasStoredPreference(legacy) ? legacy : key);
};

const OPTION_FIELDS = Object.freeze({
  strategy: 'segment_strategy',
  maxChars: 'max_chars',
  maxWords: 'max_words',
  preserveSentences: 'preserve_sentences',
  maxDurationPerRequest: 'max_duration_per_request',
  language: 'language',
});

const loadFor = (engineId, defaultStrategy) => ({
  engineId,
  strategy: readOpt(engineId, 'segment_strategy') || defaultStrategy,
  maxChars: readOpt(engineId, 'max_chars'),
  maxWords: readOpt(engineId, 'max_words'),
  preserveSentences: readOpt(engineId, 'preserve_sentences'),
  maxDurationPerRequest: readOpt(engineId, 'max_duration_per_request'),
  language: normalizeAsrLanguage(engineId, readOpt(engineId, 'language')),
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

  // A user change is stored under the active engine's key; loaded or normalized values are not.
  const patch = useCallback((field) => (value) => {
    try {
      writePreference(optionKey(engineId, OPTION_FIELDS[field]), value);
    } catch {
      return; // An unrepresentable control value keeps the current option.
    }
    setOpts((o) => ({ ...o, [field]: value }));
  }, [engineId]);

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
    setLanguage: useCallback(
      (value) => patch('language')(normalizeAsrLanguage(engineId, value)),
      [engineId, patch]
    ),
  };
};

export default useAsrOptions;
