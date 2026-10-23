import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { translateSubtitles } from '../services/geminiService';
import { PartialTranslationError } from '../services/gemini/translationChunkProcessor';
import { subscribeCurrentCacheId } from '../utils/userSubtitlesStore';
import { useTranslationBulk } from './useTranslationBulk';
import { CHECKPOINT_SOURCE } from '../events/constants';
import { getActiveTranslationCacheId } from '../platform/translationPersistence';
import {
  canonicalTranslationSourcePayload,
  createTranslationAbortError,
  normalizeRunnableLanguageChain,
} from '../utils/translationOwnership';
import {
  buildTerminal,
  callCompletion,
  isAbort,
  nextRunId,
  persistOwnedTranslationTerminal,
  requireCompleteTranslationResult,
  safeSetStorage,
  snapshotBulkTranslationSource,
} from './translationRunHelpers';
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
    includeRules,
    setIncludeRules,
    handleModelSelect,
    handleSavePrompt,
    handleSplitDurationChange,
    handleRestTimeChange,
    handleIncludeRulesChange,
  } = useTranslationPreferences();
  const [rulesAvailable, setRulesAvailable] = useState(false);
  const [userProvidedSubtitles, setUserProvidedSubtitles] = useState('');
  const hasUserProvidedSubtitles = userProvidedSubtitles.trim() !== '';

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
        if (!hasRules) {
          setIncludeRules(false);
          safeSetStorage('translation_include_rules', 'false');
        }
      } catch {
        if (!mountedRef.current) return;
        setRulesAvailable(false);
        setIncludeRules(false);
        safeSetStorage('translation_include_rules', 'false');
      }
    };
    void checkRulesAvailability();
    const refresh = () => void checkRulesAvailability();
    window.addEventListener('transcriptionRulesUpdated', refresh);
    return () => {
      window.removeEventListener('transcriptionRulesUpdated', refresh);
    };
  }, [setIncludeRules]);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const { getUserProvidedSubtitlesSync } = await import('../utils/userSubtitlesStore');
        if (!current) return;
        const value = getUserProvidedSubtitlesSync() || '';
        setUserProvidedSubtitles(value);
        if (value.trim()) {
          setIncludeRules(false);
          safeSetStorage('translation_include_rules', 'false');
        }
      } catch {
        if (current) setUserProvidedSubtitles('');
      }
    })();
    return () => { current = false; };
  }, [renderedCacheId, setIncludeRules]);

  const handleTranslate = useCallback(async (
    languages,
    delimiter = ' ',
    useParentheses = false,
    bracketStyle = null,
    chainItems = null
  ) => {
    if (activeLeaseRef.current?.kind === 'hydration') {
      activeLeaseRef.current.controller.abort(createTranslationAbortError('Translation started'));
      activeLeaseRef.current = null;
    } else if (activeLeaseRef.current !== null) {
      return { status: 'busy' };
    }
    const controller = new AbortController();
    const lease = Object.freeze({ runId: nextRunId(), controller, kind: 'translation' });
    activeLeaseRef.current = lease;

    let context = null;
    let normalizedChain = null;
    try {
      if (!Array.isArray(languages)) throw new TypeError('Translation languages must be an array');
      if (languages.length === 0 && !chainItems) {
        setError(t('translation.languageRequired', 'Please enter at least one target language'));
        return { status: 'invalid' };
      }
      const hasMainSubtitles = Array.isArray(subtitles) && subtitles.length > 0;
      const hasBulkFiles = bulkFiles.length > 0;
      if (!hasMainSubtitles && !hasBulkFiles) {
        setError(t('translation.noSubtitles', 'No subtitles to translate'));
        return { status: 'invalid' };
      }
      normalizedChain = normalizeRunnableLanguageChain(chainItems, {
        formatOnly: languages.length === 0,
      });
      const batchSource = hasBulkFiles ? snapshotBulkTranslationSource(bulkFiles) : null;
      const batchSourcePayload = hasBulkFiles
        ? canonicalTranslationSourcePayload(batchSource)
        : null;
      const runSource = hasMainSubtitles ? sourceRowsRef.current : batchSource;
      context = await captureRunContext(lease, runSource, {
        scope: hasMainSubtitles ? 'project' : 'batch',
        batchSourcePayload: hasMainSubtitles ? batchSourcePayload : null,
      });
      await assertRunOwned(context);
      const { checkpointBeforeUpdate } = await loadLifecycleOrchestrator();
      await assertRunOwned(context);
      await checkpointBeforeUpdate({
        source: CHECKPOINT_SOURCE.TRANSLATION_START,
        runId: context.runId,
        signal: context.signal,
      });
      await assertRunOwned(context);

      setError('');
      await assertRunOwned(context);
      setTranslationStatus('');
      await assertRunOwned(context);
      setIsTranslating(hasMainSubtitles);
      await assertRunOwned(context);
      setLoadedFromCache(false);
      await assertRunOwned(context);

      const ownership = {
        signal: context.signal,
        assertOwned: () => assertRunOwned(context),
        publishStatus: async (message) => {
          await assertRunOwned(context);
          setTranslationStatus(message);
          await assertRunOwned(context);
        },
        restTime,
      };
      if (hasBulkFiles) {
        const bulkOutcome = await handleBulkTranslate(
          languages,
          delimiter,
          useParentheses,
          bracketStyle,
          normalizedChain,
          hasMainSubtitles,
          ownership
        );
        await assertRunOwned(context);
        if (bulkOutcome?.status === 'failed' && !hasMainSubtitles) return bulkOutcome;
      }
      if (!hasMainSubtitles) return { status: 'complete', scope: 'bulk' };

      const streamedRows = new Map();
      const mainOwnership = {
        ...ownership,
        publishRows: (rows) => {
          if (context.signal.aborted || activeLeaseRef.current !== lease || !mountedRef.current) {
            return;
          }
          rows.forEach((row) => streamedRows.set(row.originalId, row));
          setTranslatedSubtitles(context.sourceSubtitles
            .map((row) => streamedRows.get(row.originalId))
            .filter(Boolean));
        },
      };
      const translationResult = requireCompleteTranslationResult(await translateSubtitles(
        context.sourceSubtitles,
        languages.length === 1 ? languages[0] : languages,
        selectedModel,
        customTranslationPrompt,
        splitDuration,
        includeRules,
        languages.length === 2 && useParentheses
          ? delimiter
          : (useParentheses ? null : delimiter),
        useParentheses,
        bracketStyle,
        normalizedChain,
        null,
        false,
        mainOwnership
      ));
      await assertRunOwned(context);
      if (translationResult.rows.length === 0) {
        throw new Error(t('translation.emptyResult', 'Translation returned no results'));
      }
      const terminal = buildTerminal({
        sourceFingerprint: context.sourceFingerprint,
        sourceEntryCount: context.sourceSubtitles.length,
        languageChain: normalizedChain,
        model: selectedModel,
        status: 'complete',
        rows: translationResult.rows,
      });
      await assertRunOwned(context);
      const {
        receipt,
        acknowledged,
        deliveryAcknowledgement,
      } = await persistOwnedTranslationTerminal({
        context,
        terminal,
        deliveries: translationResult.deliveries,
        assertRunOwned,
      });
      await publishComplete(context, acknowledged);
      await assertRunOwned(context);
      setTranslationStatus(t('translation.translationComplete', 'Translation complete'));
      await assertRunOwned(context);
      safeSetStorage('translation_split_duration', String(splitDuration));
      await assertRunOwned(context);
      return {
        status: 'complete',
        receipt,
        pendingDeliveryCount: deliveryAcknowledgement.pending,
      };
    } catch (translationError) {
      let terminalError = translationError;
      if (translationError instanceof PartialTranslationError && context && normalizedChain) {
        try {
          await assertRunOwned(context);
          const partialResult = translationError.result ?? Object.freeze({
            status: 'partial',
            rows: translationError.completedSubtitles,
            deliveries: Object.freeze([]),
          });
          const terminal = buildTerminal({
            sourceFingerprint: context.sourceFingerprint,
            sourceEntryCount: context.sourceSubtitles.length,
            languageChain: normalizedChain,
            model: selectedModel,
            status: 'partial',
            rows: partialResult.rows,
            failures: translationError.failedChunks,
          });
          const {
            receipt,
            acknowledged,
            deliveryAcknowledgement,
          } = await persistOwnedTranslationTerminal({
            context,
            terminal,
            deliveries: partialResult.deliveries,
            assertRunOwned,
          });
          await publishPartial(context, acknowledged);
          await assertRunOwned(context);
          setTranslationStatus(t(
            'translation.partialResult',
            'Translation stopped with {{count}} failed chunks. Retry the translation to complete it.',
            { count: acknowledged.record.failedChunks.length }
          ));
          await assertRunOwned(context);
          return {
            status: 'partial',
            receipt,
            pendingDeliveryCount: deliveryAcknowledgement.pending,
          };
        } catch (partialPersistenceError) {
          terminalError = partialPersistenceError;
        }
      }
      if (isAbort(terminalError) || controller.signal.aborted) {
        return { status: 'cancelled' };
      }
      if (context) {
        try {
          await assertRunOwned(context);
        } catch {
          return { status: 'cancelled' };
        }
      }
      if (mountedRef.current && activeLeaseRef.current === lease) {
        setError(terminalError?.message || t(
          'translation.error',
          'Error translating subtitles. Please try again.'
        ));
        if (context) {
          try {
            await assertRunOwned(context);
          } catch {
            return { status: 'cancelled' };
          }
        }
      }
      return { status: 'failed', error: terminalError };
    } finally {
      if (releaseLease(lease)) {
        if (mountedRef.current) {
          setIsTranslating(false);
          setIsBulkTranslating(false);
          setCurrentBulkFileIndex(-1);
        }
      }
    }
  }, [
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
