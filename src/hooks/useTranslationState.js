import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeCurrentCacheId } from '../utils/userSubtitlesStore';
import { useTranslationBulk } from './useTranslationBulk';
import { getActiveTranslationCacheId } from '../platform/translationPersistence';
import {
  canonicalTranslationSourcePayload,
  createTranslationAbortError,
} from '../utils/translationOwnership';
import { callCompletion } from './translationRunHelpers';
import { runTranslation } from './runTranslation';
import { useTranslationPreferences } from './useTranslationPreferences';
import { useTranslationRunOwnership } from './useTranslationRunOwnership';
import { useTranslationHydration } from './useTranslationHydration';
import { useMainTranslationRetry } from './useMainTranslationRetry';
import { useTranslationReset } from './useTranslationReset';

// Required-effective async boundary: the lifecycle orchestrator must stay out of the entry chunk.
const loadLifecycleOrchestrator = () => import('../services/lifecycleOrchestrator');

/**
 * Project-owned translation state. Every async publisher is guarded by the captured project,
 * source payload, SHA-256 fingerprint, run lease, and translation-only AbortSignal.
 */
export const useTranslationState = (subtitles, onTranslationComplete) => {
  const { t } = useTranslation();
  const [isTranslating, setIsTranslating] = useState(false);
  const [translatedSubtitles, setTranslatedSubtitles] = useState(null);
  const [error, setError] = useState('');
  const [translationStatus, setTranslationStatus] = useState('');
  const [loadedFromCache, setLoadedFromCache] = useState(false);
  const [scopeEpoch, setScopeEpoch] = useState(0);

  const {
    selectedModel,
    customTranslationPrompt,
    splitDuration,
    restTime,
    includeRules: storedIncludeRules,
    handleModelSelect,
    handleSavePrompt,
    handleSplitDurationChange,
    handleRestTimeChange,
    handleIncludeRulesChange,
  } = useTranslationPreferences();
  const [rulesAvailable, setRulesAvailable] = useState(false);
  const [userProvidedSubtitles, setUserProvidedSubtitles] = useState('');
  const hasUserProvidedSubtitles = userProvidedSubtitles.trim() !== '';
  // Rules join a run only when they exist and no user subtitles are supplied; an unavailable rule
  // set never rewrites the stored choice.
  const includeRules = storedIncludeRules && rulesAvailable && !hasUserProvidedSubtitles;

  const mountedRef = useRef(true);
  const activeLeaseRef = useRef(null);
  const hydrationControllerRef = useRef(null);
  const pendingHydrationRef = useRef(false);
  const sourcePayloadRef = useRef('');
  const sourceRowsRef = useRef(subtitles);
  const completionRef = useRef(onTranslationComplete);
  completionRef.current = onTranslationComplete;
  const releaseLease = useCallback((lease) => {
    if (activeLeaseRef.current !== lease) return false;
    activeLeaseRef.current = null;
    // A scope change can request hydration while an aborted native operation is still settling.
    // Refs do not schedule effects, so resume that read explicitly once its write lease is free.
    if (mountedRef.current && pendingHydrationRef.current) {
      pendingHydrationRef.current = false;
      setScopeEpoch((value) => value + 1);
    }
    return true;
  }, []);
  const abortForBulkSourceMutation = useCallback(() => {
    if (activeLeaseRef.current?.kind === 'translation') {
      activeLeaseRef.current.controller.abort(
        createTranslationAbortError('Translation batch source changed')
      );
    }
  }, []);

  let renderedSourcePayload = '';
  try {
    renderedSourcePayload = Array.isArray(subtitles) && subtitles.length > 0
      ? canonicalTranslationSourcePayload(subtitles)
      : '';
  } catch {
    renderedSourcePayload = '!invalid-translation-source';
  }
  sourcePayloadRef.current = renderedSourcePayload;
  sourceRowsRef.current = subtitles;
  const renderedCacheId = getActiveTranslationCacheId();
  const renderedScopeKey = `${renderedCacheId ?? ''}\u0000${renderedSourcePayload}`;
  const renderedScopeKeyRef = useRef(renderedScopeKey);
  if (renderedScopeKeyRef.current !== renderedScopeKey) {
    renderedScopeKeyRef.current = renderedScopeKey;
    activeLeaseRef.current?.controller.abort(createTranslationAbortError('Translation source changed'));
    hydrationControllerRef.current?.abort(createTranslationAbortError('Translation source changed'));
  }

  const {
    bulkFiles,
    bulkFilesRef: ownedBulkFilesRef,
    setBulkFiles,
    bulkTranslations,
    pendingBulkDeliveryCount,
    setBulkTranslations,
    isBulkTranslating,
    setIsBulkTranslating,
    currentBulkFileIndex,
    setCurrentBulkFileIndex,
    handleBulkTranslate,
    handleBulkFileRemoval,
    handleBulkFilesRemovalAll,
  } = useTranslationBulk({
    selectedModel,
    splitDuration,
    setError,
    setTranslationStatus,
    t,
    onBulkSourceMutation: abortForBulkSourceMutation,
  });
  const fallbackBulkFilesRef = useRef(bulkFiles);
  const bulkFilesRef = ownedBulkFilesRef ?? fallbackBulkFilesRef;
  bulkFilesRef.current = bulkFiles;

  const clearPublishedState = useCallback(() => {
    setTranslatedSubtitles(null);
    setLoadedFromCache(false);
    callCompletion(completionRef.current, null);
  }, []);

  const resetForScopeChange = useCallback((reason) => {
    activeLeaseRef.current?.controller.abort(createTranslationAbortError(reason));
    hydrationControllerRef.current?.abort(createTranslationAbortError(reason));
    clearPublishedState();
    setError('');
    setTranslationStatus('');
    setIsTranslating(false);
    setIsBulkTranslating(false);
    setBulkTranslations([]);
    setCurrentBulkFileIndex(-1);
  }, [
    clearPublishedState,
    setBulkTranslations,
    setCurrentBulkFileIndex,
    setIsBulkTranslating,
  ]);

  useLayoutEffect(() => {
    resetForScopeChange('Translation scope changed');
  }, [renderedScopeKey, resetForScopeChange]);

  useEffect(() => {
    const unsubscribe = subscribeCurrentCacheId(() => {
      resetForScopeChange('Translation project changed');
      setScopeEpoch((value) => value + 1);
    });
    return unsubscribe;
  }, [resetForScopeChange]);

  useEffect(() => {
    // StrictMode replays effect cleanup/setup; the replacement setup must regain liveness.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeLeaseRef.current?.controller.abort(createTranslationAbortError('Translation unmounted'));
      // The live controller at unmount is the one to abort; it is owned by useTranslationHydration.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      hydrationControllerRef.current?.abort(createTranslationAbortError('Translation unmounted'));
      callCompletion(completionRef.current, null);
    };
  }, []);

  const {
    assertRunOwned,
    captureRunContext,
    publishComplete,
    publishPartial,
  } = useTranslationRunOwnership({
    mountedRef,
    activeLeaseRef,
    sourcePayloadRef,
    sourceRowsRef,
    bulkFilesRef,
    completionRef,
    clearPublishedState,
    setBulkTranslations,
    setTranslatedSubtitles,
    setLoadedFromCache,
  });

  useTranslationHydration({
    renderedCacheId,
    renderedSourcePayload,
    scopeEpoch,
    mountedRef,
    activeLeaseRef,
    hydrationControllerRef,
    pendingHydrationRef,
    sourcePayloadRef,
    sourceRowsRef,
    assertRunOwned,
    publishComplete,
    publishPartial,
    releaseLease,
    setTranslationStatus,
    t,
  });

  useEffect(() => {
    const checkRulesAvailability = async () => {
      try {
        const { getTranscriptionRulesSync } = await import('../utils/transcriptionRulesStore');
        const hasRules = Boolean(getTranscriptionRulesSync());
        if (!mountedRef.current) return;
        setRulesAvailable(hasRules);
      } catch {
        if (!mountedRef.current) return;
        setRulesAvailable(false);
      }
    };
    void checkRulesAvailability();
    const refresh = () => void checkRulesAvailability();
    window.addEventListener('transcriptionRulesUpdated', refresh);
    return () => {
      window.removeEventListener('transcriptionRulesUpdated', refresh);
    };
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const { getUserProvidedSubtitlesSync } = await import('../utils/userSubtitlesStore');
        if (!current) return;
        const value = getUserProvidedSubtitlesSync() || '';
        setUserProvidedSubtitles(value);
      } catch {
        if (current) setUserProvidedSubtitles('');
      }
    })();
    return () => { current = false; };
  }, [renderedCacheId]);

  const handleTranslate = useCallback((
    languages,
    delimiter = ' ',
    useParentheses = false,
    bracketStyle = null,
    chainItems = null
  ) => runTranslation({
    t,
    mountedRef,
    activeLeaseRef,
    sourceRowsRef,
    subtitles,
    bulkFiles,
    settings: { selectedModel, customTranslationPrompt, splitDuration, includeRules, restTime },
    loadLifecycleOrchestrator,
    captureRunContext,
    assertRunOwned,
    publishComplete,
    publishPartial,
    releaseLease,
    handleBulkTranslate,
    setError,
    setTranslationStatus,
    setIsTranslating,
    setLoadedFromCache,
    setTranslatedSubtitles,
    setIsBulkTranslating,
    setCurrentBulkFileIndex,
  }, { languages, delimiter, useParentheses, bracketStyle, chainItems }), [
    assertRunOwned,
    bulkFiles,
    captureRunContext,
    customTranslationPrompt,
    handleBulkTranslate,
    includeRules,
    publishComplete,
    publishPartial,
    releaseLease,
    restTime,
    selectedModel,
    setCurrentBulkFileIndex,
    setIsBulkTranslating,
    splitDuration,
    subtitles,
    t,
  ]);

  const handleCancelTranslation = useCallback(() => {
    const lease = activeLeaseRef.current;
    if (lease) lease.controller.abort(createTranslationAbortError('Translation stopped'));
    setIsTranslating(false);
    setIsBulkTranslating(false);
    setCurrentBulkFileIndex(-1);
    setError(t('translation.cancelled', 'Translation cancelled by user'));
    setTranslationStatus(t('translation.cancelled', 'Translation cancelled by user'));
    return Boolean(lease);
  }, [setCurrentBulkFileIndex, setIsBulkTranslating, t]);

  const handleReset = useTranslationReset({
    mountedRef,
    activeLeaseRef,
    hydrationControllerRef,
    captureRunContext,
    assertRunOwned,
    clearPublishedState,
    releaseLease,
    setError,
    setTranslationStatus,
    t,
  });

  const retryMainTranslation = useMainTranslationRetry({
    loadLifecycleOrchestrator,
    mountedRef,
    activeLeaseRef,
    sourcePayloadRef,
    captureRunContext,
    assertRunOwned,
    publishComplete,
    publishPartial,
    releaseLease,
    customTranslationPrompt,
    includeRules,
    setError,
    setTranslationStatus,
    t,
  });

  return {
    isTranslating,
    translatedSubtitles,
    error,
    translationStatus,
    selectedModel,
    customTranslationPrompt,
    splitDuration,
    restTime,
    includeRules,
    rulesAvailable,
    hasUserProvidedSubtitles,
    loadedFromCache,
    handleModelSelect,
    handleSavePrompt,
    handleTranslate,
    handleCancelTranslation,
    handleReset,
    handleSplitDurationChange,
    handleRestTimeChange,
    handleIncludeRulesChange,
    retryMainTranslation,
    bulkFiles,
    setBulkFiles,
    bulkTranslations,
    pendingBulkDeliveryCount,
    setBulkTranslations,
    isBulkTranslating,
    currentBulkFileIndex,
    handleBulkTranslate,
    handleBulkFileRemoval,
    handleBulkFilesRemovalAll,
  };
};

export default useTranslationState;
