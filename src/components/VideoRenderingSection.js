import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SUBTITLE_CUSTOMIZATION_STORAGE_KEY,
  useSubtitleCustomization,
} from './VideoRenderingSection/subtitleCustomizationState';
import {
  loadCropSettings,
  loadNarrationSource,
  loadRenderSettings,
  loadSubtitleSource,
  storeRenderPreference,
} from './VideoRenderingSection/renderPreferences';
import QueueManagerPanel from './QueueManagerPanel';
import '../styles/VideoRenderingSection.css';
import '../styles/CollapsibleSection.css';
import '../styles/components/upload-drop-zone.css';
import '../styles/components/panel-resizer.css';
import '../styles/components/buttons.css';
import '../styles/VideoRenderingControls.css';
import '../styles/components/form-controls.css';
import { useRenderQueue } from './VideoRenderingSection/useRenderQueue';
import { useVideoUpload } from './VideoRenderingSection/useVideoUpload';
import { useNarration } from './VideoRenderingSection/useNarration';
import { usePanelResize } from './VideoRenderingSection/usePanelResize';
import { useAutoFill } from './VideoRenderingSection/useAutoFill';
import InputSelectionRow from './VideoRenderingSection/InputSelectionRow';
import RenderSettingsRow from './VideoRenderingSection/RenderSettingsRow';
import TrimTimelineRow from './VideoRenderingSection/TrimTimelineRow';
import PreviewCustomizationRow from './VideoRenderingSection/PreviewCustomizationRow';
import {
  buildNativeRenderRequest,
  cancelNativeRender,
  ensureNativeRenderProject,
  getNativeRenderStatus,
  resolveNativeRenderSource,
  runNativeRender,
} from '../platform/renderService';
import { stageNativeRenderText } from './previews/native/exportTextStaging';

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
let DEBUG_LOGS = false;
try {
  DEBUG_LOGS = typeof window !== 'undefined' && localStorage.getItem('debug_logs') === 'true';
} catch {
  DEBUG_LOGS = false;
}
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

const VideoRenderingSection = ({
  selectedVideo,
  uploadedFile,
  actualVideoUrl,
  subtitlesData,
  translatedSubtitles,
  narrationResults,
  autoFillData = null,
  onNativeVideoSelected,
}) => {
  const { t } = useTranslation();
  const [isRendering, setIsRendering] = useState(false);
  const [, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState('');
  const [, setRenderedVideoUrl] = useState('');
  const [error, setError] = useState('');
  const [renderAdmissionStage, setRenderAdmissionStage] = useState('idle');
  const [currentRenderId, setCurrentRenderId] = useState(null);
  const [abortController, setAbortController] = useState(null);
  const abortControllerRef = useRef(null);

  // Ref for the native render preview's player surface
  const videoPlayerRef = useRef(null);

  // *** FIX START ***
  // State for video duration is now separate from selectedVideoFile
  // to prevent re-render cascades that cause the video player to reload.
  const [videoDuration, setVideoDuration] = useState(0);
  // *** FIX END ***

  // Drag-drop + selected video file state (extracted hook)
  const {
    isDragging,
    selectedVideoFile,
    setSelectedVideoFile,
    handleVideoUpload,
    handleBrowseClick,
    nativeDropZoneRef,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useVideoUpload({ onNativeVideoSelected });

  // Form state with localStorage persistence
  const [selectedSubtitles, setSelectedSubtitles] = useState(loadSubtitleSource);
  const [selectedNarration, setSelectedNarration] = useState(loadNarrationSource);
  const [renderSettings, setRenderSettings] = useState(loadRenderSettings);

  // *** FIX START ***
  // This effect resets the video duration state whenever a new video file is selected.
  // This ensures that the trim range is correctly re-initialized for the new video.
  useEffect(() => {
    // A new video means we don't know the duration yet.
    setVideoDuration(0);
  }, [selectedVideoFile]); // This dependency is stable; a new file is a new object.

  // This effect sets the initial trim range once the video's duration is known.
  // It runs only when videoDuration changes from 0 to a positive number.
  useEffect(() => {
    if (videoDuration > 0) {
      setRenderSettings(prev => ({
        ...prev,
        trimStart: 0,
        trimEnd: videoDuration,
      }));
    }
  }, [videoDuration]);
  // *** FIX END ***

  // Complete by construction: `subtitleCustomizationState.js` merges the defaults on every write, so
  // the preview and every render request read one object with every key the contract names. Nothing
  // here may merge again — a second merge is a second authority.
  const [subtitleCustomization, setSubtitleCustomization] = useSubtitleCustomization();
  const [cropSettings, setCropSettings] = useState(loadCropSettings);
  const [, setNarrationUpdateTrigger] = useState(0);

  // Narration availability + aligned-audio resolver + refresh action (extracted hook)
  const {
    isRefreshingNarration,
    currentNarrationResults,
    isAlignedNarrationAvailable,
    hasNarrationSegments,
    getNarrationArtifactId,
    handleRefreshNarration,
  } = useNarration({ selectedNarration, narrationResults });

  // handleStartRender is defined further down but referenced by the render-queue hook
  // (startNextPendingRender) — thread it through a ref to avoid a circular dependency.
  const startRenderRef = useRef(null);

  // Render-queue state + persistence + SSE reconnection (extracted hook)
  const {
    renderQueue,
    setRenderQueue,
    currentQueueItem,
    startNextPendingRender,
    ownsRenderLease,
    ownQueuePlayback,
    removeFromQueue,
    clearQueue,
  } = useRenderQueue({
    setIsRendering,
    setRenderProgress,
    setRenderStatus,
    setRenderedVideoUrl,
    setError,
    currentRenderId,
    setCurrentRenderId,
    setAbortController,
    t,
    startRenderRef,
  });

  // Resizable preview/customization split panel (extracted hook)
  const { leftPanelWidth, containerRef, handleMouseDown } = usePanelResize();

  // Collapsible state - always start collapsed by default (like BackgroundImageGenerator)
  const [isCollapsed, setIsCollapsed] = useState(true); // Always start collapsed
  const [userHasCollapsed, setUserHasCollapsed] = useState(false); // Track if user has manually collapsed
  const [isClickDisabled, setIsClickDisabled] = useState(false); // Disable button for 2 seconds after click

  // Listen for narration updates to trigger re-renders
  useEffect(() => {
    const handleNarrationsUpdated = () => {
      setNarrationUpdateTrigger(prev => prev + 1);
    };

    window.addEventListener('narrations-updated', handleNarrationsUpdated);

    return () => window.removeEventListener('narrations-updated', handleNarrationsUpdated);
  }, []);

  // Apply incoming autoFillData (expand/scroll + pre-select inputs) — extracted hook
  const { sectionRef } = useAutoFill({
    autoFillData,
    actualVideoUrl,
    selectedVideo,
    uploadedFile,
    subtitlesData,
    translatedSubtitles,
    narrationResults,
    userHasCollapsed,
    setIsCollapsed,
    setUserHasCollapsed,
    setSelectedVideoFile,
    setSelectedSubtitles,
    setSelectedNarration,
  });

  // Save video rendering settings to localStorage whenever they change
  useEffect(() => {
    storeRenderPreference('videoRender_selectedSubtitles', selectedSubtitles);
  }, [selectedSubtitles]);

  useEffect(() => {
    storeRenderPreference('videoRender_selectedNarration', selectedNarration);
  }, [selectedNarration]);

  useEffect(() => {
    storeRenderPreference('videoRender_renderSettings', renderSettings, { json: true });
  }, [renderSettings]);

  useEffect(() => {
    storeRenderPreference(SUBTITLE_CUSTOMIZATION_STORAGE_KEY, subtitleCustomization, { json: true });
  }, [subtitleCustomization]);

  useEffect(() => {
    storeRenderPreference('videoRender_cropSettings', cropSettings, { json: true });
  }, [cropSettings]);

  // Note: isCollapsed state is not persisted - always starts collapsed like BackgroundImageGenerator

  // Get current subtitles based on selection
  const getCurrentSubtitles = () => {
    if (selectedSubtitles === 'translated' && translatedSubtitles && translatedSubtitles.length > 0) {
      return translatedSubtitles;
    }
    return subtitlesData || [];
  };

  // Simple render function - allows queueing multiple renders
  const handleRender = async () => {
    setError('');
    setRenderStatus(t('videoRendering.validating', 'Checking render prerequisites...'));
    setRenderAdmissionStage('validating');
    const lyrics = getCurrentSubtitles();
    if (!Array.isArray(lyrics) || lyrics.length === 0) {
      const message = t(
        'videoRendering.noSubtitlesSelected',
        'Add or generate subtitles before rendering.',
      );
      setError(message);
      setRenderStatus(t('videoRendering.failed', 'Render failed'));
      setRenderAdmissionStage('refused');
      window.addToast?.(message, 'error', 8000);
      return;
    }

    let nativeSourceAsset;
    let nativeRenderRequest;
    try {
      setRenderAdmissionStage('runtime');
      const runtime = await getNativeRenderStatus();
      if (!runtime.available) {
        const error = new Error(t(
          'videoRendering.rendererNotInstalled',
          'The video renderer is not ready. Install the native tools in Settings before rendering.',
        ));
        error.code = 'renderRuntimeUnavailable';
        throw error;
      }
      setRenderAdmissionStage('source');
      nativeSourceAsset = await resolveNativeRenderSource(selectedVideoFile);
      setRenderAdmissionStage('project');
      const projectId = await ensureNativeRenderProject(nativeSourceAsset);
      setRenderAdmissionStage('narration');
      const narrationArtifactId = selectedNarration === 'generated'
        ? await getNarrationArtifactId(selectedNarration)
        : null;
      setRenderAdmissionStage('request');
      nativeRenderRequest = buildNativeRenderRequest({
        sourceAsset: nativeSourceAsset,
        projectId,
        narrationArtifactId,
        lyrics,
        settings: renderSettings,
        customization: subtitleCustomization,
        crop: cropSettings,
      });
    } catch (error) {
      const message = error?.code === 'renderRuntimeUnavailable'
        ? t(
          'videoRendering.rendererNotInstalled',
          'The video renderer is not ready. Install the native tools in Settings before rendering.',
        )
        : error?.message || t(
          'videoRendering.invalidRenderConfiguration',
          'Check the selected video, subtitle timings, and render settings.',
        );
      setError(message);
      setRenderStatus(t('videoRendering.failed', 'Render failed'));
      setRenderAdmissionStage('refused');
      window.addToast?.(message, 'error', 8000);
      return;
    }
    // Create queue item for display
    const queueItem = {
      id: `render_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      videoFile: selectedVideoFile,
      subtitles: selectedSubtitles,
      settings: renderSettings,
      customization: subtitleCustomization,
      cropSettings: cropSettings,
      lyrics,
      narration: selectedNarration,
      nativeSourceAsset,
      nativeRenderRequest,
      status: 'pending',
      progress: 0,
      timestamp: Date.now(), // Store as timestamp number, not formatted string
      startedAt: null,
      completedAt: null,
      outputPath: null,
      error: null
    };

    // Always add to queue for display
    setRenderQueue(prev => [queueItem, ...prev]);
    setRenderStatus(t('videoRendering.queued', 'Render queued'));
    setRenderAdmissionStage('queued');
    void startNextPendingRender();
  };

  // Start rendering
  const handleStartRender = async (queueItem, renderOwner) => {
    if (!queueItem || !ownsRenderLease(renderOwner)) return;
    // Create abort controller for this render
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setAbortController(controller);

    try {
      setIsRendering(true);
      setRenderProgress(0);
      setRenderStatus(t('videoRendering.starting', 'Starting render...'));
      setError('');
      setRenderedVideoUrl('');

      // Validate inputs
      if (!selectedVideoFile && !queueItem?.videoFile
          && !queueItem?.nativeSourceAsset && !queueItem?.nativeRenderRequest) {
        throw new Error(t('videoRendering.noVideoSelected', 'Please select a video file'));
      }

      const sourceAsset = queueItem?.nativeSourceAsset || await resolveNativeRenderSource(
          queueItem?.videoFile || selectedVideoFile
        );
        const narrationSelection = queueItem?.narration ?? selectedNarration;
        const nativeRequest = queueItem?.nativeRenderRequest || buildNativeRenderRequest({
          sourceAsset,
          projectId: await ensureNativeRenderProject(sourceAsset),
          narrationArtifactId: narrationSelection === 'generated'
            ? await getNarrationArtifactId(narrationSelection)
            : null,
          lyrics: queueItem?.lyrics || getCurrentSubtitles(),
          settings: queueItem?.settings || renderSettings,
          // A queue item carries the completed style it was queued with; the live state is already
          // complete too, so neither needs merging here.
          customization: queueItem?.customization || subtitleCustomization,
          crop: queueItem?.cropSettings || cropSettings,
        });
        // The glyphs the export draws with. Rust composes text but never shapes it, so the atlas
        // and one laid-out run per cue are baked and staged here, before the job exists. A font
        // this computer cannot resolve refuses by name instead of rendering in a substitute.
        const nativeText = await stageNativeRenderText(nativeRequest, {
          source: queueItem?.videoFile || selectedVideoFile,
        });
        setRenderStatus(t('videoRendering.rendering', 'Rendering video...'));
        const completed = await runNativeRender(nativeRequest, {
          text: nativeText,
          signal: controller.signal,
          onStarted: (job) => {
            if (!ownsRenderLease(renderOwner)) return;
            setCurrentRenderId(job.id);
            const targetQueueItem = queueItem;
            if (targetQueueItem) {
              setRenderQueue(prev => prev.map(item =>
                item.id === targetQueueItem.id
                  ? { ...item, nativeJobId: job.id, nativeSourceAsset: sourceAsset }
                  : item
              ));
            }
          },
          onProgress: (event) => {
            if (!ownsRenderLease(renderOwner)) return;
            const progressPercent = Math.round(event.fractionMillionths / 10_000);
            setRenderProgress(progressPercent);
            const targetQueueItem = queueItem;
            if (targetQueueItem) {
              setRenderQueue(prev => prev.map(item =>
                item.id === targetQueueItem.id
                  ? {
                      ...item,
                      progress: progressPercent,
                      renderedFrames: event.renderedFrames,
                      durationInFrames: event.durationInFrames,
                      phase: event.phase,
                    }
                  : item
              ));
            }
          },
        });
        if (!ownsRenderLease(renderOwner)) return;
        const { result } = completed;
        const completedAt = Date.now();
        ownQueuePlayback(result.playback.id);
        setRenderedVideoUrl(result.playback.playbackUrl);
        setRenderStatus(t('videoRendering.complete', 'Render complete!'));
        setRenderProgress(100);
        const targetQueueItem = queueItem;
        if (targetQueueItem) {
          setRenderQueue(prev => prev.map(item =>
            item.id === targetQueueItem.id
              ? {
                  ...item,
                  status: 'completed',
                  progress: 100,
                  completedAt,
                  nativeJobId: completed.job.id,
                  outputPath: result.playback.playbackUrl,
                  outputPlaybackId: result.playback.id,
                  outputAssetId: result.asset.id,
                  outputArtifactId: result.artifactId,
                  outputSizeBytes: result.asset.sizeBytes,
                }
              : item
          ));
        }
      return;

    } catch (error) {
      if (!ownsRenderLease(renderOwner)) return;
      console.error('Render error:', error);

      // Check if this was an abort (cancellation)
      if (error.name === 'AbortError' || error.code === 'renderCancelled') {
        dbg('Render was aborted');
        setRenderStatus(t('videoRendering.cancelled', 'Render cancelled'));
        setRenderProgress(0);

        // Only this generation may update its queue item.
        const targetQueueItem = queueItem;
        if (targetQueueItem) {
          setRenderQueue(prev => prev.map(item =>
            item.id === targetQueueItem.id
              ? { ...item, status: 'failed', progress: 0, error: t('videoRendering.renderCancelled', 'Render was cancelled') }
              : item
          ));
        }
      } else {
        setError(error.message);
        setRenderStatus(t('videoRendering.failed', 'Render failed'));

        // Only this generation may update its queue item.
        const targetQueueItem = queueItem;
        if (targetQueueItem) {
          setRenderQueue(prev => prev.map(item =>
            item.id === targetQueueItem.id
              ? { ...item, status: 'failed', error: error.message }
              : item
          ));
        }
      }
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  };

  // Keep the ref current so the render-queue hook can invoke the latest handleStartRender.
  startRenderRef.current = handleStartRender;

  // Cancel rendering
  const handleCancelRender = async () => {
    // Update status immediately to show cancellation is in progress
    setRenderStatus(t('videoRendering.cancelling', 'Cancelling render...'));

    // The signal owns cancellation before and after the native job ID arrives.
    const activeController = abortControllerRef.current || abortController;
    if (activeController) {
      activeController.abort();
      return;
    }

    if (!currentRenderId) {
      return;
    }

    try {
      await cancelNativeRender(currentRenderId);
    } catch (error) {
      console.error('Error cancelling render:', error);
      setRenderStatus(t('videoRendering.cancelError', 'Error cancelling render'));
    }
  };

  // No automatic queue processing - simple render history display

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
          .trim-slider .standard-slider-active-track .track,
          .trim-slider .standard-slider-inactive-track .track {
            height: 10px;
          }
        `
      }} />
      <div
        ref={sectionRef}
        className={`video-rendering-section ${isCollapsed ? 'collapsed' : 'expanded'} ${isDragging ? 'dragging' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
      {/* Header - matching background-generator-header */}
      <div className="video-rendering-header">
        <div className="header-left">
          <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span className="material-symbols-rounded">movie</span>
            {t('videoRendering.title', 'Video Rendering')}
          </h2>
          <span style={{
            marginLeft: '16px',
            fontSize: '12px',
            color: 'var(--md-on-surface-variant)',
            fontStyle: 'italic',
            opacity: 0.7
          }}>
            {t('videoRendering.upcomingFeatures', 'Export subtitles, narration, styling, and effects into a finished video.')}
          </span>
        </div>
        <button
          className="collapse-button"
          disabled={isClickDisabled}
          onClick={() => {
            // Disable button for 2 seconds to prevent rapid clicking
            setIsClickDisabled(true);
            setTimeout(() => setIsClickDisabled(false), 2000);

            // Toggle collapsed state
            const newCollapsedState = !isCollapsed;
            setIsCollapsed(newCollapsedState);

            // Set userHasCollapsed flag when user manually collapses
            if (newCollapsedState) {
              setUserHasCollapsed(true);
            } else {
              // Reset the flag when user manually expands
              setUserHasCollapsed(false);
            }
          }}
        >
          <span className="material-symbols-rounded">{isCollapsed ? 'expand_more' : 'stat_1'}</span>
        </button>
      </div>

      {/* Drag overlay */}
      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-content">
            <span className="material-symbols-rounded" style={{ fontSize: '48px' }}>upload_file</span>
            <h3>{t('videoRendering.dropVideo', 'Drop video file here')}</h3>
          </div>
        </div>
      )}

      {/* Collapsed content */}
      {isCollapsed ? (
        <div className="video-rendering-collapsed-content">
          <p className="helper-message">
            {t('videoRendering.helperMessage', 'Configure video rendering settings and generate your final video with subtitles and narration')}
          </p>
        </div>
      ) : (
        /* Expanded content */
        <div className="video-rendering-content">
          {/* First row: Video Input, Subtitle Source, and Narration Audio in one line */}
          <InputSelectionRow
            selectedVideoFile={selectedVideoFile}
            hasSubtitles={getCurrentSubtitles().length > 0}
            handleVideoUpload={handleVideoUpload}
            handleBrowseClick={handleBrowseClick}
            nativeDropZoneRef={nativeDropZoneRef}
            subtitlesData={subtitlesData}
            translatedSubtitles={translatedSubtitles}
            selectedSubtitles={selectedSubtitles}
            setSelectedSubtitles={setSelectedSubtitles}
            selectedNarration={selectedNarration}
            setSelectedNarration={setSelectedNarration}
            renderSettings={renderSettings}
            setRenderSettings={setRenderSettings}
            isAlignedNarrationAvailable={isAlignedNarrationAvailable}
            hasNarrationSegments={hasNarrationSegments}
            handleRefreshNarration={handleRefreshNarration}
            isRefreshingNarration={isRefreshingNarration}
            currentNarrationResults={currentNarrationResults}
          />

          {/* Second row: Video Preview and Subtitle Customization side by side */}
          <PreviewCustomizationRow
            containerRef={containerRef}
            leftPanelWidth={leftPanelWidth}
            handleMouseDown={handleMouseDown}
            videoPlayerRef={videoPlayerRef}
            selectedVideoFile={selectedVideoFile}
            subtitles={getCurrentSubtitles()}
            selectedNarration={selectedNarration}
            isAlignedNarrationAvailable={isAlignedNarrationAvailable}
            subtitleCustomization={subtitleCustomization}
            setSubtitleCustomization={setSubtitleCustomization}
            renderSettings={renderSettings}
            cropSettings={cropSettings}
            setCropSettings={setCropSettings}
            setVideoDuration={setVideoDuration}
          />



            <TrimTimelineRow
              renderSettings={renderSettings}
              setRenderSettings={setRenderSettings}
              videoDuration={videoDuration}
              videoPlayerRef={videoPlayerRef}
            />
          {/* Render Settings and Controls - compact single row */}
          <RenderSettingsRow
            renderSettings={renderSettings}
            setRenderSettings={setRenderSettings}
            selectedVideoFile={selectedVideoFile}
            hasSubtitles={getCurrentSubtitles().length > 0}
            isRendering={isRendering}
            currentQueueItem={currentQueueItem}
            onRender={handleRender}
            onCancelRender={handleCancelRender}
          />

          {(renderAdmissionStage !== 'idle' || error) && (
            <div
              className={`render-admission-status ${error ? 'error' : ''}`}
              data-osg-render-admission={renderAdmissionStage}
              role={error ? 'alert' : 'status'}
              aria-live="polite"
            >
              {error || renderStatus}
            </div>
          )}

          {/* Rendered videos are now accessible through the queue items */}

          {/* Queue Manager - full width grid layout */}
          <div className="rendering-row queue-row">
            <QueueManagerPanel
              queue={renderQueue}
              currentQueueItem={currentQueueItem}
              onRemoveItem={removeFromQueue}
              onClearQueue={clearQueue}
              onCancelItem={handleCancelRender}
              isExpanded={true}
              onToggle={() => {}}
              gridLayout={true}
            />
          </div>
        </div>
      )}
      </div>
    </>
  );
};

export default VideoRenderingSection;
