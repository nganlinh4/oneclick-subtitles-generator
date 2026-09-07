import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import '../styles/CreateSubtitlesModal.css';
import CloseButton from './common/CloseButton';
import ScopeSelector, { formatTimeHms, validateRangeDuration } from './ScopeSelector';
import SpeechTaskTab from './SpeechTaskTab';
import TranslateTaskTab from './TranslateTaskTab';
import VisualCustomTaskTab from './VisualCustomTaskTab';
import useCreationDialogBridge from './useCreationDialogBridge';
import useFocusTrap from './useFocusTrap';

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

const getLayoutDirection = (lang) => {
  if (!lang || typeof lang !== 'string') return 'ltr';
  const prefix = lang.split('-')[0].toLowerCase();
  return RTL_LANGUAGES.has(prefix) ? 'rtl' : 'ltr';
};

/**
 * Task-First Creation Dialog (Milestone 3 / F11–F14).
 * Center around explicit tasks: Speech (default), Translate, and Visual / Custom.
 */
export const CreateSubtitlesModal = ({
  isOpen = false,
  onClose,
  onProcess,
  onCompleted,
  videoFile = null,
  videoDuration = 0,
  selectedSegment = null,
  onSelectedSegmentChange: _onSelectedSegmentChange,
  subtitlesData = [],
  userProvidedSubtitles: _userProvidedSubtitles = '',
  initialTask = 'Speech',
  projectId = null,
}) => {
  const { t, i18n } = useTranslation();
  const modalRef = useRef(null);

  // Tab State
  const [currentTask, setCurrentTask] = useState(() => {
    try {
      const saved = localStorage.getItem('osg_creation_task');
      if (saved && ['Speech', 'Translate', 'VisualCustom'].includes(saved)) {
        return saved;
      }
    } catch {
      // Ignore
    }
    return initialTask || 'Speech';
  });

  // Scope State
  const [scope, setScope] = useState(() => {
    return selectedSegment ? 'Selected range' : 'Whole video';
  });

  useEffect(() => {
    if (selectedSegment) {
      setScope('Selected range');
    }
  }, [selectedSegment]);

  // Speech Task State
  const [speechState, setSpeechState] = useState(() => ({
    engine: 'gemini-3.5-transcribe',
    language: 'auto',
    identifySpeakers: false,
    diarization: false,
    captionLayout: 'Natural',
    audioExtractedLocally: true,
    languageHints: [],
    windowDurationSecs: 120,
    segmentDelaySecs: 0,
    customMaxWords: 12,
    customMaxDuration: 5,
  }));

  // Translate Task State
  const [translateState, setTranslateState] = useState(() => ({
    targetLanguage: '',
    sourceMode: subtitlesData && subtitlesData.length > 0 ? 'existing_transcript' : 'transcribe_first',
    model: 'gemini-3.5-flash-lite',
    customInstructions: '',
    maxDuration: 10,
    segmentDelay: 0,
  }));

  // Visual / Custom Task State
  const [visualState, setVisualState] = useState(() => ({
    subtask: 'ocr',
    fps: 0.25,
    mediaResolution: 'low',
    model: 'gemini-3.1-flash-lite',
    customPrompt: '',
    useTranscriptionRules: false,
    useOutsideResultsContext: false,
    outsideContextRange: 5,
    autoSplitSubtitles: true,
  }));

  // Audio-only check
  const isAudioOnly = useMemo(() => {
    if (!videoFile) return false;
    if (videoFile.kind === 'audio') return true;
    if (typeof videoFile.type === 'string' && videoFile.type.startsWith('audio/')) return true;
    const name = videoFile.name || videoFile.path || videoFile.filePath || '';
    return /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i.test(name);
  }, [videoFile]);

  // Bridge Integration
  const bridge = useCreationDialogBridge({
    onCompleted: (event) => {
      onCompleted?.(event);
      onClose?.();
    },
    onCancelled: () => {
      // Clean neutral close
      onClose?.();
    },
  });

  // Handle escape dismissal or in-flight cancellation
  const handleEscape = useCallback(() => {
    if (bridge.isExecuting) {
      if (!bridge.isCancelling) {
        bridge.cancelTranscription();
      }
      return;
    }
    onClose?.();
  }, [bridge, onClose]);

  // Focus trap & Escape dismissal
  useFocusTrap(modalRef, isOpen, handleEscape);

  // Direction (LTR vs RTL)
  const direction = useMemo(() => getLayoutDirection(i18n.language), [i18n.language]);

  // Tab switching with arrow navigation
  const tabs = useMemo(() => [
    { id: 'Speech', label: t('processing.taskSpeech', 'Speech') },
    { id: 'Translate', label: t('processing.taskTranslate', 'Translate') },
    { id: 'VisualCustom', label: t('processing.taskVisualCustom', 'Visual / Custom') },
  ], [t]);

  const handleTabKeyDown = (e, index) => {
    let nextIndex = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIndex = (index + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIndex = tabs.length - 1;
    } else {
      return;
    }

    const nextTabId = tabs[nextIndex].id;
    setCurrentTask(nextTabId);
    try {
      localStorage.setItem('osg_creation_task', nextTabId);
    } catch {
      // Ignore
    }
    const targetElement = document.getElementById(`creation-tab-${nextTabId}`);
    targetElement?.focus();
  };

  const handleSelectTab = (tabId) => {
    setCurrentTask(tabId);
    try {
      localStorage.setItem('osg_creation_task', tabId);
    } catch {
      // Ignore
    }
  };

  // Duration & Scope Calculations
  const isWhole = scope === 'Whole video' || scope === 'whole';
  const durationSec = isWhole
    ? Math.max(0, videoDuration || 0)
    : selectedSegment
    ? Math.max(0, (selectedSegment.end || 0) - (selectedSegment.start || 0))
    : Math.max(0, videoDuration || 0);

  const isRangeValid = isWhole
    ? true
    : Boolean(
        selectedSegment &&
        typeof selectedSegment.start === 'number' &&
        typeof selectedSegment.end === 'number' &&
        Number.isFinite(selectedSegment.start) &&
        Number.isFinite(selectedSegment.end) &&
        selectedSegment.start >= 0 &&
        selectedSegment.end >= 0 &&
        selectedSegment.end > selectedSegment.start &&
        validateRangeDuration(selectedSegment.start, selectedSegment.end).valid
      );

  // Operation Summary string
  const operationSummary = useMemo(() => {
    const durStr = isWhole
      ? `00:00–${formatTimeHms(videoDuration)} (${Math.round(durationSec)}s)`
      : selectedSegment
      ? `${formatTimeHms(selectedSegment.start)}–${formatTimeHms(selectedSegment.end)} (${Math.round(durationSec)}s)`
      : `00:00 (${Math.round(durationSec)}s)`;

    if (currentTask === 'Speech') {
      const engName = speechState.engine === 'gemini-3.5-transcribe' ? 'Gemini Transcribe' : speechState.engine;
      return `${t('processing.taskSpeech', 'Speech')} · ${engName} · ${speechState.captionLayout} · ${durStr}`;
    }
    if (currentTask === 'Translate') {
      return `${t('processing.taskTranslate', 'Translate')} · ${translateState.targetLanguage || 'Target language'} · ${durStr}`;
    }
    return `${t('processing.taskVisualCustom', 'Visual')} · ${visualState.subtask} · ${durStr}`;
  }, [currentTask, speechState, translateState, visualState, isWhole, videoDuration, selectedSegment, durationSec, t]);

  // Submission Handler
  const isSubmittingRef = useRef(false);

  const handleSubmit = useCallback(async () => {
    if (isSubmittingRef.current || bridge.isExecuting || !isRangeValid) return;
    isSubmittingRef.current = true;

    try {
      const rangeStartMs = isWhole ? 0 : Math.max(0, Math.round((selectedSegment?.start || 0) * 1000));
      const rangeEndMs = isWhole
        ? Math.max(0, Math.round((videoDuration || 0) * 1000))
        : Math.max(rangeStartMs, Math.round((selectedSegment?.end || 0) * 1000));

      if (currentTask === 'Speech') {
        if (speechState.engine === 'gemini-3.5-transcribe') {
          const resolvedProjectId = projectId || videoFile?.projectId;
          if (onProcess) {
            onProcess({
              task: 'Speech',
              engine: 'gemini-3.5-transcribe',
              model: 'gemini-3.5-transcribe',
              generationScope: isWhole ? 'full-media' : 'segment',
              segment: isWhole ? undefined : selectedSegment,
              audioOnly: true,
              videoFile,
              projectId: resolvedProjectId,
              windowDurationSecs: speechState.windowDurationSecs,
              languageHints: speechState.languageHints,
              diarization: Boolean(speechState.identifySpeakers || speechState.diarization),
              captionLayout: speechState.captionLayout,
            });
            onClose?.();
            return;
          }

          const request = {
            projectId: resolvedProjectId,
            mediaAssetId: videoFile?.assetId,
            filePath: videoFile?.path || videoFile?.filePath,
            rangeStartMs,
            rangeEndMs,
            windowDurationSecs: speechState.windowDurationSecs,
            languageHints: speechState.languageHints,
            diarization: Boolean(speechState.identifySpeakers || speechState.diarization),
            config: {
              groupingPolicy: speechState.captionLayout,
            },
          };

          try {
            await bridge.startTranscription(request);
          } catch {
            // Error handled in bridge
          }
          return;
        }

        // Explicit alternative: local ASR or general Gemini
        onProcess?.({
          task: 'Speech',
          engine: speechState.engine,
          model: speechState.engine === 'gemini-general' ? (speechState.model || 'gemini-3.1-flash-lite') : undefined,
          method: speechState.engine === 'local-asr' ? 'nvidia-parakeet' : 'new',
          generationScope: isWhole ? 'full-media' : 'segment',
          segment: isWhole ? undefined : selectedSegment,
          audioOnly: true,
          videoFile,
        });
        onClose?.();
        return;
      }

      if (currentTask === 'Translate') {
        if (!translateState.targetLanguage) return;

        onProcess?.({
          task: 'Translate',
          targetLanguage: translateState.targetLanguage,
          model: translateState.model,
          customLanguage: translateState.targetLanguage,
          promptPreset: 'translate-directly',
          generationScope: isWhole ? 'full-media' : 'segment',
          segment: isWhole ? undefined : selectedSegment,
          audioOnly: true,
          videoFile,
        });
        onClose?.();
        return;
      }

      if (currentTask === 'VisualCustom') {
        if (isAudioOnly && visualState.subtask !== 'custom') return;

        onProcess?.({
          task: 'VisualCustom',
          subtask: visualState.subtask,
          model: visualState.model,
          fps: visualState.fps,
          mediaResolution: visualState.mediaResolution,
          customPrompt: visualState.customPrompt,
          useTranscriptionRules: visualState.useTranscriptionRules,
          useOutsideResultsContext: visualState.useOutsideResultsContext,
          outsideContextRange: visualState.outsideContextRange,
          autoSplitSubtitles: visualState.subtask === 'chapters' ? false : visualState.autoSplitSubtitles,
          promptPreset: visualState.subtask === 'ocr' ? 'extract-text' : visualState.subtask === 'descriptions' ? 'describe-video' : visualState.subtask === 'chapters' ? 'chaptering' : 'settings',
          generationScope: isWhole ? 'full-media' : 'segment',
          segment: isWhole ? undefined : selectedSegment,
          audioOnly: isAudioOnly,
          videoFile,
        });
        onClose?.();
        return;
      }
    } finally {
      isSubmittingRef.current = false;
    }
  }, [
    isRangeValid,
    isWhole,
    selectedSegment,
    videoDuration,
    currentTask,
    speechState,
    translateState,
    visualState,
    videoFile,
    projectId,
    isAudioOnly,
    bridge,
    onProcess,
    onClose,
  ]);

  if (!isOpen) return null;

  const isSubmitDisabled =
    bridge.isExecuting ||
    !isRangeValid ||
    (currentTask === 'Translate' && !translateState.targetLanguage) ||
    (currentTask === 'VisualCustom' && isAudioOnly && visualState.subtask !== 'custom');

  return ReactDOM.createPortal(
    <div
      className="create-subtitles-modal-overlay modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !bridge.isCancelling) {
          onClose?.();
        }
      }}
    >
      <div
        ref={modalRef}
        className="create-subtitles-modal video-processing-modal"
        dir={direction}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-subtitles-dialog-title"
      >
        {/* Header */}
        <div className="modal-header create-subtitles-header">
          <div className="create-subtitles-title-row">
            <h2 id="create-subtitles-dialog-title" className="create-subtitles-title">
              {t('processing.createSubtitlesTitle', 'Create subtitles')}
            </h2>
            <CloseButton
              variant="modal"
              size="medium"
              onClick={onClose}
              disabled={bridge.isCancelling}
              ariaLabel="Close creation dialog"
            />
          </div>

          <ScopeSelector
            scope={scope}
            onScopeChange={setScope}
            videoDuration={videoDuration}
            selectedSegment={selectedSegment}
          />
        </div>

        {/* Tab List */}
        <div className="create-subtitles-tablist-container">
          <div className="create-subtitles-tablist" role="tablist" aria-label="Creation Tasks">
            {tabs.map((tab, idx) => {
              const isActive = currentTask === tab.id;
              const taskKey = tab.id === 'Speech' ? 'speech' : tab.id === 'Translate' ? 'translate' : 'visual';
              return (
                <button
                  key={tab.id}
                  id={`creation-tab-${tab.id}`}
                  data-task-tab={taskKey}
                  type="button"
                  role="tab"
                  className={`create-subtitles-tab ${isActive ? 'active' : ''}`}
                  aria-selected={isActive}
                  aria-controls={`creation-panel-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => handleSelectTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  disabled={bridge.isExecuting}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body Content */}
        <div
          id={`creation-panel-${currentTask}`}
          className="modal-content create-subtitles-body"
          role="tabpanel"
          aria-labelledby={`creation-tab-${currentTask}`}
          tabIndex={0}
        >
          {/* Bridge Execution Progress Surface */}
          {bridge.isExecuting && (
            <div className="creation-progress-card" role="status" aria-live="polite">
              <div className="creation-progress-header">
                <span className="creation-progress-stage">{bridge.stageMessage || bridge.stage}</span>
                <span className="creation-progress-percent">
                  {Math.round(bridge.progressFraction * 100)}%
                </span>
              </div>

              <div className="creation-progress-bar-track">
                <div
                  className="creation-progress-bar-fill"
                  style={{ width: `${Math.round(bridge.progressFraction * 100)}%` }}
                />
              </div>

              <div className="creation-progress-stats">
                <span>Words recognized: {bridge.stats.wordsCount}</span>
                {bridge.stats.totalWindows > 1 && (
                  <span>
                    Window {bridge.stats.windowIndex} of {bridge.stats.totalWindows}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Bridge Error Surface */}
          {bridge.error && (() => {
            const isQuota =
              bridge.error.code === 'quota_exceeded' ||
              /429/.test(bridge.error.code || '') ||
              /429/.test(bridge.error.message || '');
            const isNoAudio =
              bridge.error.code === 'no_audio' ||
              /audio/i.test(bridge.error.message || '') ||
              /audio/i.test(bridge.error.code || '');

            return (
              <div className="creation-info-banner error" role="alert">
                <span style={{ fontSize: 18 }}>⚠️</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <strong>
                    {isQuota
                      ? t('processing.quotaExceededTitle', 'Gemini API Quota Exceeded')
                      : isNoAudio
                      ? t('processing.noAudioTrackTitle', 'No Audio Track Found')
                      : 'Transcription Failed'}
                  </strong>
                  <span>{bridge.error.message}</span>
                  {bridge.stats.wordsCount > 0 && (
                    <span style={{ fontSize: 12 }}>
                      {t(
                        'processing.partialTranscriptionDesc',
                        '{{completed}} of {{total}} windows completed ({{words}} words saved).',
                        {
                          completed: bridge.stats.windowIndex,
                          total: bridge.stats.totalWindows,
                          words: bridge.stats.wordsCount,
                        }
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Active Panel View */}
          {!bridge.isExecuting && currentTask === 'Speech' && (
            <SpeechTaskTab state={speechState} onChange={setSpeechState} />
          )}

          {!bridge.isExecuting && currentTask === 'Translate' && (
            <TranslateTaskTab
              state={translateState}
              onChange={setTranslateState}
              hasExistingTranscript={subtitlesData && subtitlesData.length > 0}
              transcriptCuesCount={subtitlesData ? subtitlesData.length : 0}
            />
          )}

          {!bridge.isExecuting && currentTask === 'VisualCustom' && (
            <VisualCustomTaskTab
              state={visualState}
              onChange={setVisualState}
              isAudioOnly={isAudioOnly}
            />
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer create-subtitles-footer">
          <div className="footer-content">
            <div className="footer-token-info">
              <div className="creation-summary-text" title={operationSummary}>
                {operationSummary}
              </div>
            </div>

            <div className="creation-action-buttons">
              {bridge.isExecuting ? (
                <button
                  type="button"
                  className="creation-btn creation-btn-danger"
                  data-osg-action="cancel-generation"
                  onClick={bridge.cancelTranscription}
                  disabled={bridge.isCancelling}
                >
                  {bridge.isCancelling ? 'Cancelling...' : t('processing.cancelTranscription', 'Cancel transcription')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="creation-btn-secondary"
                    onClick={onClose}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="process-btn"
                    data-osg-action="process-subtitles"
                    data-action="create-subtitles"
                    data-testid="create-subtitles-action"
                    disabled={isSubmitDisabled}
                    onClick={handleSubmit}
                  >
                    {t('processing.createSubtitlesAction', 'Create subtitles')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CreateSubtitlesModal;
