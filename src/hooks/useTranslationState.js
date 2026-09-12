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
import { generateSubtitleHash } from '../utils/subtitle/subtitleHash';
import { getCurrentMediaId } from '../utils/mediaId';
import { subscribeCurrentCacheId } from '../utils/userSubtitlesStore';
import { useTranslationBulk } from './useTranslationBulk';
import { DEFAULT_TRANSLATION_MODEL_ID, migrateGeminiModelId } from '../config/geminiModels';
import { CHECKPOINT_SOURCE } from '../events/constants';
import {
  assertActiveTranslationIdentity,
  assertTranslationPersistenceReceipt,
  captureTranslationRevision,
  clearTranslationForIdentity,
  commitTranslationRevision,
  getActiveTranslationCacheId,
  persistTranslationForIdentity,
  readTranslationForIdentity,
  resolveTranslationIdentity,
} from '../platform/translationPersistence';
import {
  TRANSLATION_SCHEMA_VERSION,
  assertTranslationTerminalMatchesSource,
  canonicalTranslationSourcePayload,
  createTranslationAbortError,
  fingerprintTranslationSourcePayload,
  normalizeRunnableLanguageChain,
  snapshotTranslationSource,
} from '../utils/translationOwnership';

// Re-export legacy helpers for consumers that only need display/cache labels.
export { generateSubtitleHash, getCurrentMediaId };

// Required-effective async boundary: the lifecycle orchestrator must stay out of the entry chunk.
const loadLifecycleOrchestrator = () => import('../services/lifecycleOrchestrator');

let translationRunSequence = 0;
const nextRunId = () => {
  translationRunSequence = (translationRunSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `translation-${Date.now().toString(36)}-${translationRunSequence.toString(36)}`;
};

const safeGetStorage = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSetStorage = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Compatibility preferences are best-effort and never own a durable result.
  }
};

const boundedIntegerSetting = (key, fallback, maximum) => {
  const raw = safeGetStorage(key);
  if (!/^(0|[1-9]\d*)$/.test(raw ?? '')) return fallback;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number <= maximum ? number : fallback;
};

const callCompletion = (callback, subtitles) => {
  try {
    callback?.(subtitles);
  } catch {
    // Downstream notification failure cannot reverse an acknowledged translation.
  }
};

const isAbort = (error) => error?.name === 'AbortError'
  || error?.code === 'translationAborted'
  || error?.code === 'projectScopeMismatch';

const buildTerminal = ({
  sourceFingerprint,
  sourceEntryCount,
  languageChain,
  model,
  status,
  rows,
  failures = [],
}) => ({
  schemaVersion: TRANSLATION_SCHEMA_VERSION,
  sourceFingerprint,
  sourceEntryCount,
  languageChain,
  model,
  status,
  baseSubtitles: rows,
  failedChunks: failures,
});

const requireCompleteTranslationResult = (value) => {
  if (!value || value.status !== 'complete'
      || !Array.isArray(value.rows)
      || !Array.isArray(value.deliveries)
      || value.deliveries.some((delivery) => typeof delivery?.acknowledge !== 'function')) {
    throw new TypeError('Translation returned an invalid owned result');
  }
  return value;
};

const acknowledgePersistedDeliveries = async (deliveries) => {
  const outcomes = await Promise.allSettled(deliveries.map((delivery) => (
    Promise.resolve().then(() => delivery.acknowledge())
  )));
  return Object.freeze({
    attempted: outcomes.length,
    pending: outcomes.filter((outcome) => outcome.status === 'rejected').length,
  });
};

const languageOptionsFromChain = (chain) => {
  const languages = chain
    .filter((item) => item.type === 'language' && !item.isOriginal)
    .map((item) => item.value.trim())
    .filter(Boolean);
  const delimiter = chain.find((item) => item.type === 'delimiter') ?? null;
  return {
    languages,
    delimiter: delimiter?.value ?? ' ',
    bracketStyle: delimiter?.style ?? null,
    useParentheses: Boolean(delimiter?.style?.open || delimiter?.style?.close),
  };
};

const snapshotBulkTranslationSource = (files) => {
  const rows = [];
  files.forEach((file, fileIndex) => {
    const fileRows = snapshotTranslationSource(file?.subtitles);
    const fileName = typeof file?.name === 'string' ? file.name : `file-${fileIndex}`;
    rows.push({
      id: `bulk-file:${fileIndex}`,
      start: 0,
      end: 0,
      text: fileName,
    });
    fileRows.forEach((row) => {
      rows.push({
        id: `bulk:${fileIndex}:${row.originalId}`,
        start: row.start,
        end: row.end,
        text: row.text,
      });
    });
  });
  return snapshotTranslationSource(rows);
};

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

  const [selectedModel, setSelectedModel] = useState(() => migrateGeminiModelId(
    safeGetStorage('translation_model') || safeGetStorage('gemini_model'),
    DEFAULT_TRANSLATION_MODEL_ID
  ));
  const [customTranslationPrompt, setCustomTranslationPrompt] = useState(
    () => safeGetStorage('custom_prompt_translation') || null
  );
  const [splitDuration, setSplitDuration] = useState(
    () => boundedIntegerSetting('translation_split_duration', 0, 24 * 60)
  );
  const [restTime, setRestTime] = useState(
    () => boundedIntegerSetting('translation_rest_time', 0, 24 * 60 * 60)
  );
  const [includeRules, setIncludeRules] = useState(
    () => safeGetStorage('translation_include_rules') === 'true'
  );
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

  useLayoutEffect(() => {
    activeLeaseRef.current?.controller.abort(createTranslationAbortError('Translation scope changed'));
    hydrationControllerRef.current?.abort(createTranslationAbortError('Translation scope changed'));
    clearPublishedState();
    setError('');
    setTranslationStatus('');
    setIsTranslating(false);
    setIsBulkTranslating(false);
    setBulkTranslations([]);
    setCurrentBulkFileIndex(-1);
  }, [
    clearPublishedState,
    renderedScopeKey,
    setBulkTranslations,
    setCurrentBulkFileIndex,
    setIsBulkTranslating,
  ]);

  useEffect(() => {
    const unsubscribe = subscribeCurrentCacheId(() => {
      activeLeaseRef.current?.controller.abort(createTranslationAbortError('Translation project changed'));
      hydrationControllerRef.current?.abort(createTranslationAbortError('Translation project changed'));
      clearPublishedState();
      setError('');
      setTranslationStatus('');
      setIsTranslating(false);
      setIsBulkTranslating(false);
      setBulkTranslations([]);
      setCurrentBulkFileIndex(-1);
      setScopeEpoch((value) => value + 1);
    });
    return unsubscribe;
  }, [
    clearPublishedState,
    setBulkTranslations,
    setCurrentBulkFileIndex,
    setIsBulkTranslating,
  ]);

  useEffect(() => {
    // StrictMode replays effect cleanup/setup; the replacement setup must regain liveness.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeLeaseRef.current?.controller.abort(createTranslationAbortError('Translation unmounted'));
      hydrationControllerRef.current?.abort(createTranslationAbortError('Translation unmounted'));
      callCompletion(completionRef.current, null);
    };
  }, []);

  const assertLeaseSync = useCallback((
    lease,
    cacheId,
    sourcePayload,
    scope = 'project'
  ) => {
    let liveSourcePayload = '!invalid-translation-source';
    try {
      if (scope === 'batch') {
        liveSourcePayload = canonicalTranslationSourcePayload(
          snapshotBulkTranslationSource(bulkFilesRef.current)
        );
      } else {
        liveSourcePayload = Array.isArray(sourceRowsRef.current) && sourceRowsRef.current.length > 0
          ? canonicalTranslationSourcePayload(sourceRowsRef.current)
          : '';
      }
    } catch {
      // The invalid sentinel below fails the exact-payload comparison.
    }
    const sourceChanged = liveSourcePayload !== sourcePayload
      || (scope === 'project' && sourcePayloadRef.current !== sourcePayload);
    const cacheChanged = scope === 'project' && getActiveTranslationCacheId() !== cacheId;
    if (!mountedRef.current || activeLeaseRef.current !== lease || lease.controller.signal.aborted
        || cacheChanged || sourceChanged) {
      if (sourceChanged || cacheChanged) {
        if (mountedRef.current && activeLeaseRef.current === lease) {
          clearPublishedState();
          setBulkTranslations([]);
        }
      }
      lease.controller.abort(createTranslationAbortError('Translation ownership changed'));
      throw createTranslationAbortError('Translation ownership changed');
    }
  }, [bulkFilesRef, clearPublishedState, setBulkTranslations]);

  const assertRunOwned = useCallback(async (context) => {
    assertLeaseSync(context.lease, context.cacheId, context.sourcePayload, context.scope);
    if (context.scope === 'batch') return;
    if (typeof context.batchSourcePayload === 'string') {
      assertLeaseSync(context.lease, null, context.batchSourcePayload, 'batch');
    }
    try {
      await assertActiveTranslationIdentity(context.identity);
    } catch (ownershipError) {
      context.lease.controller.abort(createTranslationAbortError('Translation project changed'));
      if (ownershipError?.code === 'projectScopeMismatch') {
        if (mountedRef.current && activeLeaseRef.current === context.lease) {
          clearPublishedState();
          setBulkTranslations([]);
        }
      }
      throw ownershipError;
    }
    assertLeaseSync(context.lease, context.cacheId, context.sourcePayload, context.scope);
    if (typeof context.batchSourcePayload === 'string') {
      assertLeaseSync(context.lease, null, context.batchSourcePayload, 'batch');
    }
  }, [assertLeaseSync, clearPublishedState, setBulkTranslations]);

  const captureRunContext = useCallback(async (
    lease,
    runSourceRows = sourceRowsRef.current,
    { scope = 'project', batchSourcePayload = null } = {}
  ) => {
    const sourceSubtitles = snapshotTranslationSource(runSourceRows);
    const fingerprintPayload = canonicalTranslationSourcePayload(sourceSubtitles);
    if (scope === 'batch') {
      assertLeaseSync(lease, null, fingerprintPayload, scope);
      const sourceFingerprint = await fingerprintTranslationSourcePayload(fingerprintPayload);
      assertLeaseSync(lease, null, fingerprintPayload, scope);
      return Object.freeze({
        runId: lease.runId,
        cacheId: null,
        projectId: null,
        sourceFingerprint,
        sourceSubtitles,
        signal: lease.controller.signal,
        identity: null,
        sourcePayload: fingerprintPayload,
        scope,
        batchSourcePayload: null,
        lease,
      });
    }
    const cacheId = getActiveTranslationCacheId();
    const activeSourcePayload = sourcePayloadRef.current;
    const assertCapturedSources = () => {
      assertLeaseSync(lease, cacheId, activeSourcePayload, scope);
      if (typeof batchSourcePayload === 'string') {
        assertLeaseSync(lease, null, batchSourcePayload, 'batch');
      }
    };
    assertCapturedSources();
    const identity = await resolveTranslationIdentity(cacheId, { create: false });
    assertCapturedSources();
    const sourceFingerprint = await fingerprintTranslationSourcePayload(fingerprintPayload);
    assertCapturedSources();
    await assertActiveTranslationIdentity(identity);
    assertCapturedSources();
    return Object.freeze({
      runId: lease.runId,
      cacheId,
      projectId: identity.projectId,
      sourceFingerprint,
      sourceSubtitles,
      signal: lease.controller.signal,
      identity,
      sourcePayload: activeSourcePayload,
      scope,
      batchSourcePayload,
      lease,
    });
  }, [assertLeaseSync]);

  const publishComplete = useCallback(async (context, acknowledged, {
    loaded = false,
  } = {}) => {
    const rows = acknowledged.record.baseSubtitles;
    await assertRunOwned(context);
    setTranslatedSubtitles(rows);
    await assertRunOwned(context);
    setLoadedFromCache(loaded);
    await assertRunOwned(context);
    callCompletion(completionRef.current, rows);
    await assertRunOwned(context);
  }, [assertRunOwned]);

  // Hydrate only the exact active project/source. Starting another hydration aborts the old one.
  useEffect(() => {
    pendingHydrationRef.current = false;
    if (!renderedCacheId || !renderedSourcePayload
        || renderedSourcePayload === '!invalid-translation-source') return undefined;
    if (activeLeaseRef.current !== null) {
      pendingHydrationRef.current = true;
      return undefined;
    }
    const controller = new AbortController();
    const lease = Object.freeze({
      runId: nextRunId(),
      controller,
      kind: 'hydration',
    });
    activeLeaseRef.current = lease;
    hydrationControllerRef.current?.abort(createTranslationAbortError('New translation hydration'));
    hydrationControllerRef.current = controller;
    const hydrationScope = { cacheId: renderedCacheId, sourcePayload: renderedSourcePayload };
    const assertHydration = async (identity = null) => {
      if (!mountedRef.current || activeLeaseRef.current !== lease || controller.signal.aborted
          || getActiveTranslationCacheId() !== hydrationScope.cacheId
          || sourcePayloadRef.current !== hydrationScope.sourcePayload) {
        throw createTranslationAbortError('Translation hydration ownership changed');
      }
      if (identity) await assertActiveTranslationIdentity(identity);
      if (!mountedRef.current || activeLeaseRef.current !== lease || controller.signal.aborted
          || getActiveTranslationCacheId() !== hydrationScope.cacheId
          || sourcePayloadRef.current !== hydrationScope.sourcePayload) {
        throw createTranslationAbortError('Translation hydration ownership changed');
      }
    };

    void (async () => {
      try {
        await assertHydration();
        const identity = await resolveTranslationIdentity(hydrationScope.cacheId, { create: false });
        await assertHydration(identity);
        const fingerprint = await fingerprintTranslationSourcePayload(hydrationScope.sourcePayload);
        await assertHydration(identity);
        const record = await readTranslationForIdentity(identity);
        await assertHydration(identity);
        const hydrationSource = snapshotTranslationSource(sourceRowsRef.current);
        if (record === null || record.sourceFingerprint !== fingerprint
            || record.sourceEntryCount !== hydrationSource.length) return;
        try {
          assertTranslationTerminalMatchesSource(record, hydrationSource);
        } catch {
          return;
        }
        const context = Object.freeze({
          runId: lease.runId,
          cacheId: identity.cacheId,
          projectId: identity.projectId,
          sourceFingerprint: fingerprint,
          sourceSubtitles: hydrationSource,
          signal: controller.signal,
          identity,
          sourcePayload: hydrationScope.sourcePayload,
          scope: 'project',
          batchSourcePayload: null,
          lease,
        });
        if (record.status === 'partial') {
          await assertRunOwned(context);
          setTranslationStatus(t(
            'translation.partialResult',
            'Translation stopped with {{count}} failed chunks. Retry the translation to complete it.',
            { count: record.failedChunks.length }
          ));
          await assertRunOwned(context);
          return;
        }
        const acknowledged = { record };
        await publishComplete(context, acknowledged, { loaded: true });
        await assertRunOwned(context);
        setTranslationStatus(t('translation.loadedFromCache', 'Translations loaded from cache'));
        await assertRunOwned(context);
      } catch (hydrationError) {
        if (!isAbort(hydrationError)) {
          console.error('Error hydrating the active project translation:', hydrationError);
        }
      } finally {
        releaseLease(lease);
      }
    })();
    return () => {
      controller.abort(createTranslationAbortError('Translation hydration changed'));
      if (activeLeaseRef.current === lease) activeLeaseRef.current = null;
    };
  }, [
    assertRunOwned,
    publishComplete,
    releaseLease,
    renderedCacheId,
    renderedSourcePayload,
    scopeEpoch,
    t,
  ]);

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
  }, []);

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
  }, [renderedCacheId]);

  const handleModelSelect = useCallback((modelId) => {
    setSelectedModel(modelId);
    safeSetStorage('translation_model', modelId);
  }, []);

  const handleSavePrompt = useCallback((prompt) => {
    setCustomTranslationPrompt(prompt);
    safeSetStorage('custom_prompt_translation', prompt);
  }, []);

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
        ownership
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
      assertTranslationTerminalMatchesSource(terminal, context.sourceSubtitles);
      await assertRunOwned(context);
      const receipt = await persistTranslationForIdentity(context.identity, terminal);
      await assertRunOwned(context);
      const acknowledged = assertTranslationPersistenceReceipt(receipt, context.identity, {
        sourceFingerprint: context.sourceFingerprint,
        status: 'complete',
      });
      assertTranslationPersistenceReceipt(receipt, context.identity, {
        revision: acknowledged.record.revision,
        sourceFingerprint: context.sourceFingerprint,
        status: 'complete',
      });
      await assertRunOwned(context);
      const deliveryAcknowledgement = await acknowledgePersistedDeliveries(
        translationResult.deliveries
      );
      await assertRunOwned(context);
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
          assertTranslationTerminalMatchesSource(terminal, context.sourceSubtitles);
          await assertRunOwned(context);
          const receipt = await persistTranslationForIdentity(context.identity, terminal);
          await assertRunOwned(context);
          const acknowledged = assertTranslationPersistenceReceipt(receipt, context.identity, {
            sourceFingerprint: context.sourceFingerprint,
            status: 'partial',
          });
          assertTranslationPersistenceReceipt(receipt, context.identity, {
            revision: acknowledged.record.revision,
            sourceFingerprint: context.sourceFingerprint,
            status: 'partial',
          });
          await assertRunOwned(context);
          const deliveryAcknowledgement = await acknowledgePersistedDeliveries(
            partialResult.deliveries
          );
          await assertRunOwned(context);
          setTranslatedSubtitles(null);
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

  const handleReset = useCallback(async () => {
    if (activeLeaseRef.current?.kind === 'reset') return { status: 'busy' };
    activeLeaseRef.current?.controller.abort(createTranslationAbortError('Translation reset'));
    hydrationControllerRef.current?.abort(createTranslationAbortError('Translation reset'));
    const controller = new AbortController();
    const lease = Object.freeze({ runId: nextRunId(), controller, kind: 'reset' });
    activeLeaseRef.current = lease;
    try {
      const context = await captureRunContext(lease);
      await assertRunOwned(context);
      const receipt = await clearTranslationForIdentity(context.identity);
      await assertRunOwned(context);
      assertTranslationPersistenceReceipt(receipt, context.identity);
      await assertRunOwned(context);
      clearPublishedState();
      await assertRunOwned(context);
      setError('');
      await assertRunOwned(context);
      setTranslationStatus('');
      await assertRunOwned(context);
      return { status: 'cleared', receipt };
    } catch (resetError) {
      if (!isAbort(resetError) && mountedRef.current && activeLeaseRef.current === lease) {
        setError(resetError?.message || t('translation.error', 'Could not reset translation'));
      }
      return { status: isAbort(resetError) ? 'cancelled' : 'failed', error: resetError };
    } finally {
      releaseLease(lease);
    }
  }, [assertRunOwned, captureRunContext, clearPublishedState, releaseLease, t]);

  const retryMainTranslation = useCallback(async (segment) => {
    if (activeLeaseRef.current?.kind === 'hydration') {
      activeLeaseRef.current.controller.abort(createTranslationAbortError('Translation retry started'));
      activeLeaseRef.current = null;
    } else if (activeLeaseRef.current !== null) {
      return { status: 'busy' };
    }
    const requestedIds = Array.isArray(segment?.originalIds)
      ? [...segment.originalIds]
      : (segment?.originalId === undefined ? [] : [segment.originalId]);
    if (requestedIds.length === 0 || new Set(requestedIds).size !== requestedIds.length) {
      return { status: 'invalid', error: new Error('A retry requires exact original subtitle IDs') };
    }
    const controller = new AbortController();
    const lease = Object.freeze({ runId: nextRunId(), controller, kind: 'retry' });
    activeLeaseRef.current = lease;
    let context = null;
    try {
      context = await captureRunContext(lease);
      await assertRunOwned(context);
      const { checkpointBeforeUpdate } = await loadLifecycleOrchestrator();
      await assertRunOwned(context);
      await checkpointBeforeUpdate({
        source: CHECKPOINT_SOURCE.TRANSLATION_START,
        runId: context.runId,
        signal: context.signal,
      });
      await assertRunOwned(context);
      const revision = await captureTranslationRevision(context.identity);
      await assertRunOwned(context);
      const record = await readTranslationForIdentity(context.identity);
      await assertRunOwned(context);
      if (record?.status !== 'complete' || record.sourceFingerprint !== context.sourceFingerprint
          || record.revision !== revision.revision) {
        throw new Error('The durable translation changed before retry');
      }
      const sourceById = new Map(context.sourceSubtitles.map((row) => [row.originalId, row]));
      const retrySource = requestedIds.map((id) => sourceById.get(id));
      if (retrySource.some((row) => row === undefined)) {
        throw new Error('The retry subtitle no longer belongs to this source');
      }
      const options = languageOptionsFromChain(record.languageChain);
      if (options.languages.length === 0) {
        throw new Error('Formatted-only translations do not require provider retry');
      }
      const ownership = {
        signal: context.signal,
        assertOwned: () => assertRunOwned(context),
        publishStatus: async (message) => {
          await assertRunOwned(context);
          setTranslationStatus(message);
          await assertRunOwned(context);
        },
        restTime: 0,
      };
      const translationResult = requireCompleteTranslationResult(await translateSubtitles(
        retrySource,
        options.languages.length === 1 ? options.languages[0] : options.languages,
        record.model,
        customTranslationPrompt,
        0,
        includeRules,
        options.delimiter,
        options.useParentheses,
        options.bracketStyle,
        record.languageChain,
        null,
        false,
        ownership
      ));
      await assertRunOwned(context);
      if (translationResult.rows.length !== requestedIds.length) {
        throw new Error('Retry result did not match the captured original IDs');
      }
      const replacement = new Map(translationResult.rows.map((row) => [row.originalId, row]));
      if (replacement.size !== requestedIds.length
          || requestedIds.some((id) => !replacement.has(id))) {
        throw new Error('Retry result lost its original subtitle identity');
      }
      const rows = record.baseSubtitles.map((row) => replacement.get(row.originalId) ?? row);
      const terminal = buildTerminal({
        sourceFingerprint: context.sourceFingerprint,
        sourceEntryCount: context.sourceSubtitles.length,
        languageChain: record.languageChain,
        model: record.model,
        status: 'complete',
        rows,
      });
      assertTranslationTerminalMatchesSource(terminal, context.sourceSubtitles);
      await assertRunOwned(context);
      const receipt = await commitTranslationRevision(context.identity, revision, terminal);
      await assertRunOwned(context);
      const acknowledged = assertTranslationPersistenceReceipt(receipt, context.identity, {
        revision: record.revision + 1,
        sourceFingerprint: context.sourceFingerprint,
        status: 'complete',
      });
      await assertRunOwned(context);
      const deliveryAcknowledgement = await acknowledgePersistedDeliveries(
        translationResult.deliveries
      );
      await assertRunOwned(context);
      await publishComplete(context, acknowledged);
      await assertRunOwned(context);
      setTranslationStatus(t('translation.translationComplete', 'Translation complete'));
      await assertRunOwned(context);
      return {
        status: 'complete',
        receipt,
        pendingDeliveryCount: deliveryAcknowledgement.pending,
      };
    } catch (retryError) {
      if (isAbort(retryError) || controller.signal.aborted) return { status: 'cancelled' };
      if (context) {
        try {
          await assertRunOwned(context);
        } catch {
          return { status: 'cancelled' };
        }
      }
      if (mountedRef.current && activeLeaseRef.current === lease
          && getActiveTranslationCacheId() === context?.cacheId
          && sourcePayloadRef.current === context?.sourcePayload) {
        setError(retryError?.message || t('translation.error', 'Translation retry failed'));
        try {
          await assertRunOwned(context);
        } catch {
          return { status: 'cancelled' };
        }
      }
      return { status: 'failed', error: retryError };
    } finally {
      releaseLease(lease);
    }
  }, [
    assertRunOwned,
    captureRunContext,
    customTranslationPrompt,
    includeRules,
    publishComplete,
    releaseLease,
    t,
  ]);

  const handleSplitDurationChange = useCallback((value) => {
    setSplitDuration(value);
    safeSetStorage('translation_split_duration', String(value));
  }, []);
  const handleRestTimeChange = useCallback((value) => {
    setRestTime(value);
    safeSetStorage('translation_rest_time', String(value));
  }, []);
  const handleIncludeRulesChange = useCallback((value) => {
    setIncludeRules(value);
    safeSetStorage('translation_include_rules', String(value));
  }, []);

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
