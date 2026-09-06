import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  startWordNativeTranscription,
  cancelWordNativeTranscription,
} from '../platform/nativeWordTranscription';
import { showInfoToast, showSuccessToast } from '../utils/toastUtils';

/**
 * Bridge between Task-First Creation Dialog and the authoritative native word transcription engine.
 *
 * @param {Object} options
 * @param {(event: Object) => void} [options.onCompleted]
 * @param {(event: Object) => void} [options.onCancelled]
 * @param {(event: Object) => void} [options.onPartialPromotion]
 * @param {(error: Object) => void} [options.onError]
 */
export const useCreationDialogBridge = ({
  onCompleted,
  onCancelled,
  onPartialPromotion,
  onError,
} = {}) => {
  const { t } = useTranslation();
  const [isExecuting, setIsExecuting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [stage, setStage] = useState('idle');
  const [stageMessage, setStageMessage] = useState('');
  const [progressFraction, setProgressFraction] = useState(0);
  const [stats, setStats] = useState({
    wordsCount: 0,
    turnsCount: 0,
    windowIndex: 0,
    totalWindows: 1,
  });
  const [error, setError] = useState(null);

  const isStartingRef = useRef(false);
  const activeTaskIdRef = useRef(null);
  const promotedCountRef = useRef(0);

  const startTranscription = useCallback(async (request) => {
    if (isExecuting || isStartingRef.current) return;
    isStartingRef.current = true;
    setIsExecuting(true);
    setIsCancelling(false);
    setError(null);
    setStage('audio_extracting');
    setStageMessage(t('processing.stageExtractingAudio', 'Extracting audio and initializing transcription...'));
    setProgressFraction(0.05);
    promotedCountRef.current = 0;
    setStats({
      wordsCount: 0,
      turnsCount: 0,
      windowIndex: 0,
      totalWindows: 1,
    });

    try {
      const snapshot = await startWordNativeTranscription(request, {
        onStageChanged: (event) => {
          setStage(event.stage || 'audio_extracting');
          if (event.message) {
            setStageMessage(event.message);
          }
          if (event.totalWindows) {
            setStats((prev) => ({
              ...prev,
              windowIndex: event.windowIndex ?? prev.windowIndex,
              totalWindows: event.totalWindows,
            }));
          }
        },
        onWindowProgress: (event) => {
          const total = event.totalWindows || 1;
          const currentPromoted = promotedCountRef.current;
          const currentFraction = event.fraction || 0;
          const calculated = (currentPromoted + currentFraction * 0.85) / total;
          setProgressFraction(Math.min(0.95, Math.max(0.05, calculated)));
        },
        onWindowPromoted: (event) => {
          promotedCountRef.current += 1;
          setStats((prev) => ({
            ...prev,
            wordsCount: prev.wordsCount + (event.wordCount || 0),
            turnsCount: prev.turnsCount + (event.turnCount || 0),
            windowIndex: event.windowIndex !== undefined ? event.windowIndex + 1 : prev.windowIndex + 1,
            totalWindows: event.totalWindows || prev.totalWindows,
          }));
          const total = event.totalWindows || 1;
          setProgressFraction(Math.min(0.98, promotedCountRef.current / total));
          onPartialPromotion?.(event);
        },
        onCompleted: (event) => {
          setProgressFraction(1.0);
          setStage('completed');
          setIsExecuting(false);
          setIsCancelling(false);
          activeTaskIdRef.current = null;
          const wordCount = event.totalWords ?? event.wordsCount ?? 0;
          try {
            showSuccessToast(
              t('processing.transcriptionCompleted', 'Transcription completed ({{count}} words)', {
                count: wordCount,
              })
            );
          } catch {
            // Best effort toast
          }
          onCompleted?.(event);
        },
        onCancelled: (event) => {
          setIsExecuting(false);
          setIsCancelling(false);
          setStage('idle');
          activeTaskIdRef.current = null;
          try {
            showInfoToast(t('processing.transcriptionCancelled', 'Transcription cancelled'));
          } catch {
            // Best effort toast
          }
          onCancelled?.(event);
        },
        onFailed: (event) => {
          setIsExecuting(false);
          setIsCancelling(false);
          setStage('failed');
          activeTaskIdRef.current = null;
          const errPayload = event.error || {
            code: 'transcription_failed',
            message: event.message || 'Transcription failed',
          };
          setError(errPayload);
          onError?.(errPayload);
        },
        onError: (err) => {
          setIsExecuting(false);
          setIsCancelling(false);
          setStage('failed');
          activeTaskIdRef.current = null;
          const errPayload = {
            code: 'client_error',
            message: err.message || 'Client error occurred',
          };
          setError(errPayload);
          onError?.(errPayload);
        },
      });

      if (snapshot?.id) {
        activeTaskIdRef.current = snapshot.id;
      }
      return snapshot;
    } catch (err) {
      setIsExecuting(false);
      setIsCancelling(false);
      setStage('failed');
      activeTaskIdRef.current = null;
      const errPayload = {
        code: 'invocation_failed',
        message: err.message || 'Failed to start transcription',
      };
      setError(errPayload);
      onError?.(errPayload);
      return { error: errPayload };
    } finally {
      isStartingRef.current = false;
    }
  }, [t, onCompleted, onCancelled, onPartialPromotion, onError, isExecuting]);

  const cancelTranscription = useCallback(async () => {
    const taskId = activeTaskIdRef.current;
    if (!taskId) return;
    setIsCancelling(true);
    try {
      await cancelWordNativeTranscription(taskId);
    } catch (err) {
      console.warn('[useCreationDialogBridge] Cancel invocation warning:', err);
    }
  }, []);

  const reset = useCallback(() => {
    isStartingRef.current = false;
    setIsExecuting(false);
    setIsCancelling(false);
    setStage('idle');
    setStageMessage('');
    setProgressFraction(0);
    setError(null);
    activeTaskIdRef.current = null;
    promotedCountRef.current = 0;
    setStats({
      wordsCount: 0,
      turnsCount: 0,
      windowIndex: 0,
      totalWindows: 1,
    });
  }, []);

  return {
    isExecuting,
    isCancelling,
    stage,
    stageMessage,
    progressFraction,
    stats,
    error,
    activeTaskId: activeTaskIdRef.current,
    startTranscription,
    cancelTranscription,
    reset,
  };
};

export default useCreationDialogBridge;
