import { useEffect, useRef, useState } from 'react';
import { EVENTS } from '../../../events/constants';
import {
  analyzeVideoAndWaitForUserChoice,
  commitVideoAnalysisForContext,
} from '../../../utils/videoProcessing/analysisUtils';
import { getTranscriptionRulesForCache } from '../../../utils/transcriptionRulesStore';
import {
  getUserProvidedSubtitlesForCache,
  subscribeCurrentCacheId,
} from '../../../utils/userSubtitlesStore';
import { getVideoDuration } from '../../../utils/durationUtils';
import { showErrorToast, showInfoToast } from '../../../utils/toastUtils';
import {
  assertAutoGenerationContextCurrent,
  assertAutoGenerationContextDurable,
  createAutoGenerationContext,
  createAutoGenerationRequest,
  isAutoGenerationCancellation,
  isAutoGenerationCompletion,
  subscribeAutoGenerationOwnership,
} from '../../../utils/autoGenerationOwnership';
import { buildAutoGenerateOptions } from './autoGenerateOptions';

const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1_000;
const loadLifecycleOrchestrator = () => import('../../../services/lifecycleOrchestrator');

const createRunId = () => (
  globalThis.crypto?.randomUUID?.()
  ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const useAutoGenerateFlow = ({
  apiKeysSet,
  t = (_key, fallback) => fallback,
  handleGenerateSubtitles,
  handleProcessWithOptions,
  isVercelMode = false,
}) => {
  const [isAutoGenerating, setIsAutoGenerating] = useState(false);
  const [autoFlowStep, setAutoFlowStep] = useState('');
  const autoFlowAbortedRef = useRef(false);
  const autoFlowActiveRef = useRef(false);
  const controllerRef = useRef(null);
  const presentationRef = useRef(null);

  const waitForAnalysisComplete = (context) => new Promise((resolve, reject) => {
    assertAutoGenerationContextCurrent(context);
    let settled = false;
    let timeout = null;
    let unsubscribeCache = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      window.removeEventListener(EVENTS.VIDEO_ANALYSIS_SETTLED, handleSettled);
      context.signal.removeEventListener('abort', handleAbort);
      unsubscribeCache?.();
      callback();
    };
    const handleAbort = () => finish(() => reject(context.signal.reason ?? new DOMException(
      'Automatic subtitle generation was stopped.',
      'AbortError'
    )));
    const handleSettled = (event) => {
      const detail = event?.detail;
      if (detail?.runId !== context.runId
          || detail?.cacheId !== context.cacheId
          || detail?.projectId !== context.projectId) return;
      if (detail.success === true) {
        try {
          assertAutoGenerationContextCurrent(context);
          finish(resolve);
        } catch (error) {
          finish(() => reject(error));
        }
      } else {
        finish(() => reject(new Error('Video analysis was not accepted.')));
      }
    };

    window.addEventListener(EVENTS.VIDEO_ANALYSIS_SETTLED, handleSettled);
    context.signal.addEventListener('abort', handleAbort, { once: true });
    unsubscribeCache = subscribeCurrentCacheId((cacheId) => {
      if (cacheId !== context.cacheId) {
        finish(() => reject(new Error('The active media changed during video analysis.')));
      }
    });
    timeout = setTimeout(() => {
      finish(() => reject(new Error(
        'Automatic subtitle generation timed out while waiting for video analysis.'
      )));
    }, ANALYSIS_TIMEOUT_MS);
    if (context.signal.aborted) handleAbort();
  });

  const startAutoGenerateFlow = async () => {
    if (autoFlowActiveRef.current || isAutoGenerating) return false;
    if (!apiKeysSet?.gemini) {
      showErrorToast(t('errors.apiKeyRequired', 'Gemini API key is required'), 4_000);
      return false;
    }
    if (typeof handleGenerateSubtitles !== 'function' || typeof handleProcessWithOptions !== 'function') {
      showErrorToast(t('autoFlow.unavailable', 'Automatic subtitle generation is unavailable.'), 4_000);
      return false;
    }

    const controller = new AbortController();
    const request = createAutoGenerationRequest({ runId: createRunId(), signal: controller.signal });
    const presentationToken = Object.freeze({ runId: request.runId });
    presentationRef.current = presentationToken;
    controllerRef.current = controller;
    autoFlowActiveRef.current = true;
    autoFlowAbortedRef.current = false;
    setIsAutoGenerating(true);
    let unsubscribeOwnership = null;
    const mayPresent = (context = null) => {
      if (presentationRef.current !== presentationToken || controllerRef.current !== controller) {
        return false;
      }
      if (context !== null) {
        try {
          assertAutoGenerationContextCurrent(context);
        } catch {
          return false;
        }
      }
      return true;
    };
    const present = (callback, context = null) => {
      if (!mayPresent(context)) return false;
      callback();
      return true;
    };

    try {
      present(() => setAutoFlowStep('saving'));
      const { checkpointBeforeUpdate } = await loadLifecycleOrchestrator();
      await checkpointBeforeUpdate({
        source: 'auto-generation-start',
        runId: request.runId,
        signal: request.signal,
      });
      if (request.signal.aborted) throw request.signal.reason;

      present(() => setAutoFlowStep('loading'));
      const prepared = await handleGenerateSubtitles(request);
      const context = createAutoGenerationContext(prepared);
      assertAutoGenerationContextCurrent(context);
      unsubscribeOwnership = subscribeAutoGenerationOwnership(context, (error) => {
        if (controllerRef.current === controller && !controller.signal.aborted) {
          controller.abort(error);
        }
      });

      present(() => setAutoFlowStep('analyzing'), context);
      let rules = await getTranscriptionRulesForCache(context.cacheId, {
        expectedProjectId: context.projectId,
      });
      if (!rules) {
        const analysis = await analyzeVideoAndWaitForUserChoice(
          context.media,
          () => undefined,
          t,
          { signal: context.signal, context }
        );
        assertAutoGenerationContextCurrent(context);
        await commitVideoAnalysisForContext({
          context,
          analysisResult: analysis.analysisResult,
          showCountdown: true,
        });
        await waitForAnalysisComplete(context);
        rules = await getTranscriptionRulesForCache(context.cacheId, {
          expectedProjectId: context.projectId,
        });
      } else {
        present(() => showInfoToast(
          t('autoFlow.usingExistingAnalysis', 'Using existing analysis rules'),
          2_000
        ), context);
      }
      assertAutoGenerationContextCurrent(context);

      const userProvidedSubtitles = await getUserProvidedSubtitlesForCache(context.cacheId, {
        expectedProjectId: context.projectId,
      });
      assertAutoGenerationContextCurrent(context);

      present(() => setAutoFlowStep('processing'), context);
      const duration = await getVideoDuration(context.media);
      await assertAutoGenerationContextDurable(context);
      const options = buildAutoGenerateOptions({
        videoFile: context.media,
        duration,
        isVercelMode,
        transcriptionRules: rules,
        userProvidedSubtitles,
        autoRunContext: context,
      });
      const completion = await handleProcessWithOptions(options);
      await assertAutoGenerationContextDurable(context);
      if (!isAutoGenerationCompletion(completion, context)) {
        throw new Error('Automatic subtitle processing did not produce a durable result.');
      }

      present(() => setAutoFlowStep('complete'), context);
      return true;
    } catch (error) {
      if (!isAutoGenerationCancellation(error, controller.signal) && mayPresent()) {
        showErrorToast(t(
          'autoFlow.error',
          'Automatic subtitle generation failed: {{message}}',
          { message: error?.message || 'Unknown error' },
        ), 4_000);
      }
      return false;
    } finally {
      unsubscribeOwnership?.();
      if (presentationRef.current === presentationToken) {
        presentationRef.current = null;
        if (controllerRef.current === controller) controllerRef.current = null;
        autoFlowActiveRef.current = false;
        setIsAutoGenerating(false);
        setAutoFlowStep('');
      }
    }
  };

  const stopAutoFlow = () => {
    autoFlowAbortedRef.current = true;
    controllerRef.current?.abort(new DOMException(
      'Automatic subtitle generation was stopped.',
      'AbortError'
    ));
  };

  useEffect(() => () => {
    presentationRef.current = null;
    controllerRef.current?.abort(new DOMException(
      'Automatic subtitle generation was stopped because its owner was closed.',
      'AbortError'
    ));
  }, []);

  return {
    isAutoGenerating,
    autoFlowStep,
    autoFlowAbortedRef,
    autoFlowActiveRef,
    startAutoGenerateFlow,
    waitForAnalysisComplete,
    stopAutoFlow,
  };
};

export default useAutoGenerateFlow;
