import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import TranscriptionRulesEditor from './TranscriptionRulesEditor';
import {
  analyzeVideoAndWaitForUserChoice,
  commitVideoAnalysisForContext,
} from '../utils/videoProcessing/analysisUtils';
import {
  getTranscriptionRulesSync,
  setTranscriptionRulesForCache,
} from '../utils/transcriptionRulesStore';
import {
  assertAutoGenerationContextCurrent,
  assertAutoGenerationContextDurable,
  captureActiveMediaRunContext,
  isAutoGenerationContext,
} from '../utils/autoGenerationOwnership';
import LoadingIndicator from './common/LoadingIndicator';
import { showErrorToast, showWarningToast } from '../utils/toastUtils';
import { EVENTS } from '../events/constants';
import '../styles/VideoAnalysisButton.css';

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };


// Custom analyze icon: panel with Gemini star inside
const AnalyzeIcon = ({ size = 16 }) => (
  <span className="material-symbols-rounded" style={{ fontSize: size }}>auto_awesome</span>
);

/**
 * Button component for video analysis functionality
 * @param {Object} props - Component props
 * @param {boolean} props.disabled - Whether the button is disabled
 * @param {File} props.uploadedFile - The uploaded file (original)
 * @param {File} props.uploadedFileData - The processed file data (ready for processing)
 * @returns {JSX.Element} - Rendered component
 */
const VideoAnalysisButton = ({ disabled = false, uploadedFile = null, uploadedFileData = null }) => {
  const { t } = useTranslation();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [showRulesEditor, setShowRulesEditor] = useState(false);
  const [transcriptionRules, setTranscriptionRulesState] = useState(null);
  const [lastVideoIdentifier, setLastVideoIdentifier] = useState(null);
  const [editorContext, setEditorContext] = useState(null);
  const analysisControllerRef = useRef(null);
  const manualEditorControllerRef = useRef(null);

  const publishAnalysisSettled = (context, success) => {
    if (!isAutoGenerationContext(context)) return;
    window.dispatchEvent(new CustomEvent(EVENTS.VIDEO_ANALYSIS_SETTLED, {
      detail: {
        success,
        runId: context.runId,
        cacheId: context.cacheId,
        projectId: context.projectId,
      },
    }));
  };

  // Check for existing transcription rules on mount
  useEffect(() => {
    const checkExistingRules = () => {
      const rules = getTranscriptionRulesSync();
      setHasAnalysis(!!rules);
      setTranscriptionRulesState(rules);
    };

    checkExistingRules();

    // Listen for openRulesEditorWithCountdown event
    const handleOpenRulesEditorWithCountdown = (event) => {
      const { context, transcriptionRules, recommendedPresetId, showCountdown } = event.detail;
      try {
        assertAutoGenerationContextCurrent(context);
      } catch {
        return;
      }
      if (transcriptionRules) {
        manualEditorControllerRef.current?.abort();
        manualEditorControllerRef.current = null;
        setEditorContext(context);
        setTranscriptionRulesState(transcriptionRules);
        setHasAnalysis(true);

        // Save the recommended preset directly to localStorage so it's used immediately
        if (recommendedPresetId) {
          localStorage.setItem('video_processing_prompt_preset', recommendedPresetId);
          sessionStorage.setItem('current_session_preset_id', recommendedPresetId);
        }

        // Store countdown flag for the rules editor
        if (showCountdown) {
          sessionStorage.setItem('show_rules_editor_countdown', 'true');
        }

        setShowRulesEditor(true);
      }
    };

    window.addEventListener('openRulesEditorWithCountdown', handleOpenRulesEditorWithCountdown);

    return () => {
      window.removeEventListener('openRulesEditorWithCountdown', handleOpenRulesEditorWithCountdown);
      analysisControllerRef.current?.abort();
      manualEditorControllerRef.current?.abort();
    };
  }, []);

  // React to video file changes
  useEffect(() => {
    // Get a unique identifier for the current video
    // Include file size and last modified date for better uniqueness
    const getVideoFingerprint = (file) => {
      if (!file) return null;
      return `${file.name}_${file.size}_${file.lastModified || ''}`;
    };
    
    const currentFingerprint = getVideoFingerprint(uploadedFileData || uploadedFile);
    
    // Check if video has actually changed
    if (currentFingerprint !== lastVideoIdentifier) {
      dbg('[VideoAnalysisButton] Video changed from:', lastVideoIdentifier, 'to:', currentFingerprint);
      
      // The media activation boundary already switched the project-scoped rule
      // store before publishing this file. Never clear here: doing so would
      // delete the newly selected video's durable rules rather than the old
      // video's rules. Hydration events will refresh this local view.
      const activeRules = getTranscriptionRulesSync();
      setHasAnalysis(!!activeRules);
      setTranscriptionRulesState(activeRules);
      setShowRulesEditor(false);
      setIsAnalyzing(false);
      if (editorContext) publishAnalysisSettled(editorContext, false);
      manualEditorControllerRef.current?.abort();
      manualEditorControllerRef.current = null;
      setEditorContext(null);
      
      // Update the last video identifier
      setLastVideoIdentifier(currentFingerprint);
      
    }
  }, [uploadedFile, uploadedFileData, lastVideoIdentifier, editorContext]);

  // Listen for transcription rules updates
  useEffect(() => {
    const handleRulesUpdated = (event) => {
      const { rules } = event.detail;
      // Only update if the rules are different from what we have
      if (JSON.stringify(rules) !== JSON.stringify(transcriptionRules)) {
        setHasAnalysis(!!rules);
        setTranscriptionRulesState(rules);
      }
    };

    window.addEventListener('transcriptionRulesUpdated', handleRulesUpdated);

    return () => {
      window.removeEventListener('transcriptionRulesUpdated', handleRulesUpdated);
    };
  }, [transcriptionRules]);

  // Analyze only the media descriptor owned by this mounted editor. Historical window globals
  // were an unversioned second source of truth and could point at the previous project.
  const getCurrentVideoFile = () => {
    const videoFile = uploadedFileData || uploadedFile;

    if (videoFile) {
      dbg('[VideoAnalysisButton] Found video file:', videoFile.name || 'unnamed file');
      return videoFile;
    }

    dbg('[VideoAnalysisButton] No video file found');
    return null;
  };

  const handleAnalyzeVideo = async () => {
    const videoFile = getCurrentVideoFile();
    if (!videoFile) {
      showWarningToast(t('videoAnalysis.noVideoFile', 'No video file available for analysis. Please upload or download a video first.'), 4000);
      return;
    }

    // Clear any previous recommendation before starting new analysis
    sessionStorage.removeItem('current_session_preset_id');
    sessionStorage.removeItem('last_applied_recommendation');
    sessionStorage.removeItem('current_session_video_fingerprint');
    sessionStorage.removeItem('current_session_prompt');
    
    setIsAnalyzing(true);
    const controller = new AbortController();
    analysisControllerRef.current?.abort();
    analysisControllerRef.current = controller;

    try {
      // Create a status update callback
      const onStatusUpdate = (status) => {
        dbg('Video analysis status:', status.message);
      };

      // Perform video analysis
      const context = await captureActiveMediaRunContext({
        runId: globalThis.crypto?.randomUUID?.() ?? `analysis-${Date.now()}`,
        media: videoFile,
        signal: controller.signal,
      });
      const result = await analyzeVideoAndWaitForUserChoice(
        videoFile,
        onStatusUpdate,
        t,
        { signal: controller.signal, context }
      );
      assertAutoGenerationContextCurrent(context);
      await commitVideoAnalysisForContext({
        context,
        analysisResult: result.analysisResult,
        delivery: result.delivery,
        showCountdown: true,
      });
    } catch (error) {
      console.error('Error during video analysis:', error);
      if (error?.name !== 'AbortError') {
        showErrorToast(t('videoAnalysis.error', 'Video analysis failed: {{message}}', { message: error.message }), 5000);
      }
    } finally {
      if (analysisControllerRef.current === controller) analysisControllerRef.current = null;
      setIsAnalyzing(false);
    }
  };

  const handleEditRules = async () => {
    const videoFile = getCurrentVideoFile();
    if (!videoFile) {
      showWarningToast(t(
        'videoAnalysis.noVideoFile',
        'No video file available for analysis. Please upload or download a video first.'
      ), 4_000);
      return false;
    }
    const controller = new AbortController();
    manualEditorControllerRef.current?.abort();
    manualEditorControllerRef.current = controller;
    try {
      const context = await captureActiveMediaRunContext({
        runId: globalThis.crypto?.randomUUID?.() ?? `rules-${Date.now()}`,
        media: videoFile,
        signal: controller.signal,
      });
      if (manualEditorControllerRef.current !== controller) return false;
      await assertAutoGenerationContextDurable(context);
      setEditorContext(context);
      setShowRulesEditor(true);
      return true;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        showErrorToast(t(
          'videoAnalysis.error',
          'Video analysis failed: {{message}}',
          { message: error.message }
        ), 5_000);
      }
      return false;
    }
  };

  const handleSaveRules = async (editedRules) => {
    await assertAutoGenerationContextDurable(editorContext);
    await setTranscriptionRulesForCache(editorContext.cacheId, editedRules, {
      expectedProjectId: editorContext.projectId,
    });
    await assertAutoGenerationContextDurable(editorContext);
    setTranscriptionRulesState(editedRules);
    setHasAnalysis(!!editedRules);
    setShowRulesEditor(false);
    publishAnalysisSettled(editorContext, true);
    setEditorContext(null);
    manualEditorControllerRef.current?.abort();
    manualEditorControllerRef.current = null;
  };

  const handleClearAnalysis = async () => {
    const videoFile = getCurrentVideoFile();
    if (!videoFile) return false;
    const controller = editorContext ? null : new AbortController();
    try {
      const context = editorContext ?? await captureActiveMediaRunContext({
        runId: globalThis.crypto?.randomUUID?.() ?? `rules-clear-${Date.now()}`,
        media: videoFile,
        signal: controller.signal,
      });
      await assertAutoGenerationContextDurable(context);
      await setTranscriptionRulesForCache(context.cacheId, null, {
        expectedProjectId: context.projectId,
      });
      await assertAutoGenerationContextDurable(context);
      setHasAnalysis(false);
      setTranscriptionRulesState(null);
      setShowRulesEditor(false);
      sessionStorage.removeItem('current_session_preset_id');
      sessionStorage.removeItem('last_applied_recommendation');
      sessionStorage.removeItem('current_session_video_fingerprint');
      sessionStorage.removeItem('current_session_prompt');
      if (editorContext) publishAnalysisSettled(editorContext, true);
      setEditorContext(null);
      manualEditorControllerRef.current?.abort();
      manualEditorControllerRef.current = null;
      return true;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        showErrorToast(t(
          'videoAnalysis.error',
          'Video analysis failed: {{message}}',
          { message: error.message }
        ), 5_000);
      }
      return false;
    } finally {
      controller?.abort();
    }
  };

  const handleCloseRulesEditor = () => {
    setShowRulesEditor(false);
    if (editorContext) {
      try {
        assertAutoGenerationContextCurrent(editorContext);
        publishAnalysisSettled(editorContext, true);
      } catch {
        publishAnalysisSettled(editorContext, false);
      }
    }
    setEditorContext(null);
    manualEditorControllerRef.current?.abort();
    manualEditorControllerRef.current = null;
  };

  const handleChangePrompt = (preset) => {
    // The TranscriptionRulesEditor already saves to localStorage
    // We just need to log for debugging
    dbg('[VideoAnalysisButton] Preset changed in Rules Editor:', preset?.id || 'custom');
  };


  return (
    <>
      <div className="video-analysis-buttons-group">
        <div className="video-analysis-button-container">
          <button
            className={`video-analysis-button ${hasAnalysis ? 'has-analysis' : ''} ${isAnalyzing ? 'processing' : ''}`}
            onClick={hasAnalysis ? handleEditRules : handleAnalyzeVideo}
            disabled={disabled || isAnalyzing}
            title={hasAnalysis
              ? t('videoAnalysis.editTooltip', 'Edit transcription rules')
              : t('videoAnalysis.analyzeTooltip', 'Analyze video to generate transcription rules')}
          >
            {/* Dynamic Gemini effects container - populated by particle system */}
            <div className="gemini-icon-container"></div>

            {isAnalyzing ? (
              <span className="processing-text-container">
                <LoadingIndicator
                  theme="light"
                  showContainer={false}
                  size={16}
                  className="analysis-processing-loading"
                  color="#FFFFFF"
                />
                <span className="processing-text">
                  {t('videoAnalysis.analyzing', 'Analyzing...')}
                </span>
              </span>
            ) : hasAnalysis ? (
              <>
                <span className="material-symbols-rounded icon">edit</span>
                <span>{t('videoAnalysis.editRules', 'Edit rules')}</span>
              </>
            ) : (
              <>
                <AnalyzeIcon size={16} />
                <span>{t('videoAnalysis.addAnalysis', 'Add analysis')}</span>
              </>
            )}
          </button>
        </div>

        {/* Separate clear button */}
        {hasAnalysis && !isAnalyzing && (
          <button
            className="clear-analysis-button"
            onClick={handleClearAnalysis}
            title={t('videoAnalysis.clearAnalysis', 'Clear video analysis')}
            data-tooltip={t('videoAnalysis.clearAnalysis', 'Clear video analysis')}
            aria-label={t('videoAnalysis.clearAnalysis', 'Clear video analysis')}
            disabled={disabled}
          >
            <span className="material-symbols-rounded">close</span>
          </button>
        )}
      </div>

      {/* Transcription Rules Editor Modal */}
      {showRulesEditor && (
        <TranscriptionRulesEditor
          isOpen={showRulesEditor}
          onClose={handleCloseRulesEditor}
          initialRules={transcriptionRules}
          onSave={handleSaveRules}
          onCancel={handleCloseRulesEditor}
          onChangePrompt={handleChangePrompt}
        />
      )}
    </>
  );
};

export default VideoAnalysisButton;
