import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { defaultCustomization } from './SubtitleCustomizationPanel';
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
  resolveNativeRenderSource,
  runNativeRender,
} from '../platform/renderService';

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };


const VideoRenderingSection = ({
  selectedVideo,
  uploadedFile,
  actualVideoUrl,
  subtitlesData,
  translatedSubtitles,
  narrationResults,
  autoFillData = null
}) => {
  const { t } = useTranslation();
  const [isRendering, setIsRendering] = useState(false);
  const [, setRenderProgress] = useState(0);
  const [, setRenderStatus] = useState('');
  const [, setRenderedVideoUrl] = useState('');
  const [, setError] = useState('');
  const [currentRenderId, setCurrentRenderId] = useState(null);
  const [abortController, setAbortController] = useState(null);
  const isRenderingRef = useRef(isRendering);
  isRenderingRef.current = isRendering;

  // Ref for the Remotion video player
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
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useVideoUpload();

  // Form state with localStorage persistence
  const [selectedSubtitles, setSelectedSubtitles] = useState(() => {
    return localStorage.getItem('videoRender_selectedSubtitles') || 'original';
  });
  const [selectedNarration, setSelectedNarration] = useState(() => {
    return localStorage.getItem('videoRender_selectedNarration') || 'none';
  });
  const [renderSettings, setRenderSettings] = useState(() => {
    const saved = localStorage.getItem('videoRender_renderSettings');
    const defaultSettings = {
      resolution: '1080p',
      frameRate: 30,
      videoType: 'Subtitled Video',
      originalAudioVolume: 100,
      narrationVolume: 100,
      trimStart: 0,
      trimEnd: 0,
    };
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...defaultSettings, ...parsed };
    }
    return defaultSettings;
  });

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

  const [subtitleCustomization, setSubtitleCustomization] = useState(() => {
    const saved = localStorage.getItem('videoRender_subtitleCustomization');
    return saved ? JSON.parse(saved) : defaultCustomization;
  });
  const [cropSettings, setCropSettings] = useState(() => {
    const saved = localStorage.getItem('videoRender_cropSettings');
    return saved ? JSON.parse(saved) : {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      aspectRatio: null
    };
  });
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
    setCurrentQueueItem,
    startNextPendingRender,
    removeFromQueue,
    clearQueue,
  } = useRenderQueue({
    isRendering,
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
    localStorage.setItem('videoRender_selectedSubtitles', selectedSubtitles);
  }, [selectedSubtitles]);

  useEffect(() => {
    localStorage.setItem('videoRender_selectedNarration', selectedNarration);
  }, [selectedNarration]);

  useEffect(() => {
    localStorage.setItem('videoRender_renderSettings', JSON.stringify(renderSettings));
  }, [renderSettings]);

  useEffect(() => {
    localStorage.setItem('videoRender_subtitleCustomization', JSON.stringify(subtitleCustomization));
  }, [subtitleCustomization]);

  useEffect(() => {
    localStorage.setItem('videoRender_cropSettings', JSON.stringify(cropSettings));
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
    let nativeSourceAsset = null;
    let nativeRenderRequest = null;
    try {
      nativeSourceAsset = await resolveNativeRenderSource(selectedVideoFile);
      const projectId = await ensureNativeRenderProject(nativeSourceAsset);
      const narrationArtifactId = selectedNarration === 'generated'
        ? await getNarrationArtifactId(selectedNarration)
        : null;
      nativeRenderRequest = buildNativeRenderRequest({
        sourceAsset: nativeSourceAsset,
        projectId,
        narrationArtifactId,
        lyrics: getCurrentSubtitles(),
        settings: renderSettings,
        customization: { ...defaultCustomization, ...subtitleCustomization },
        crop: cropSettings,
      });
    } catch {
      // The start path reports the existing invalid-video error and keeps the queue contract.
    }
    const shouldQueue = isRenderingRef.current;
    // Create queue item for display
    const queueItem = {
      id: `render_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      videoFile: selectedVideoFile,
      subtitles: selectedSubtitles,
      settings: renderSettings,
      customization: { ...defaultCustomization, ...subtitleCustomization },
      cropSettings: cropSettings,
      lyrics: getCurrentSubtitles(),
      narration: selectedNarration,
      nativeSourceAsset,
      nativeRenderRequest,
      status: shouldQueue ? 'pending' : 'processing',
      progress: 0,
      timestamp: Date.now(), // Store as timestamp number, not formatted string
      startedAt: shouldQueue ? null : Date.now(),
      completedAt: null,
      outputPath: null,
      error: null
    };

    // Always add to queue for display
    setRenderQueue(prev => [queueItem, ...prev]);

    // If not currently rendering, start this one immediately
    if (!shouldQueue) {
      setCurrentQueueItem(queueItem);
      await handleStartRender(queueItem);
    }
  };

  // Start rendering
  const handleStartRender = async (queueItem = null) => {
    // Create abort controller for this render
    const controller = new AbortController();
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
          customization: {
            ...defaultCustomization,
            ...(queueItem?.customization || subtitleCustomization),
          },
          crop: queueItem?.cropSettings || cropSettings,
        });
        setRenderStatus(t('videoRendering.rendering', 'Rendering video...'));
        const completed = await runNativeRender(nativeRequest, {
          signal: controller.signal,
          onStarted: (job) => {
            setCurrentRenderId(job.id);
            const targetQueueItem = queueItem || currentQueueItem;
            if (targetQueueItem) {
              setRenderQueue(prev => prev.map(item =>
                item.id === targetQueueItem.id
                  ? { ...item, nativeJobId: job.id, nativeSourceAsset: sourceAsset }
                  : item
              ));
            }
          },
          onProgress: (event) => {
            const progressPercent = Math.round(event.fractionMillionths / 10_000);
            setRenderProgress(progressPercent);
            const targetQueueItem = queueItem || currentQueueItem;
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
        const { result } = completed;
        const completedAt = Date.now();
        setRenderedVideoUrl(result.playback.playbackUrl);
        setRenderStatus(t('videoRendering.complete', 'Render complete!'));
        setRenderProgress(100);
        const targetQueueItem = queueItem || currentQueueItem;
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
      console.error('Render error:', error);

      // Check if this was an abort (cancellation)
      if (error.name === 'AbortError' || error.code === 'renderCancelled') {
        dbg('Render was aborted');
        setRenderStatus(t('videoRendering.cancelled', 'Render cancelled'));
        setRenderProgress(0);

        // Update queue item as cancelled (use passed queueItem or fallback to currentQueueItem)
        const targetQueueItem = queueItem || currentQueueItem;
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

        // Update queue item as failed (use passed queueItem or fallback to currentQueueItem)
        const targetQueueItem = queueItem || currentQueueItem;
        if (targetQueueItem) {
          setRenderQueue(prev => prev.map(item =>
            item.id === targetQueueItem.id
              ? { ...item, status: 'failed', error: error.message }
              : item
          ));
        }
      }
    } finally {
      setIsRendering(false);
      setCurrentRenderId(null);
      setAbortController(null);

      // Render finished - reset state and start next
      setCurrentQueueItem(null);
      setTimeout(() => startNextPendingRender(), 1000);
    }
  };

  // Keep the ref current so the render-queue hook can invoke the latest handleStartRender.
  startRenderRef.current = handleStartRender;

  // Cancel rendering
  const handleCancelRender = async () => {
    // First, abort the fetch request if we have an abort controller
    if (abortController) {
      abortController.abort();
    }

    // Update status immediately to show cancellation is in progress
    setRenderStatus(t('videoRendering.cancelling', 'Cancelling render...'));

    if (!currentRenderId) {
      setIsRendering(false);
      setRenderStatus(t('videoRendering.cancelled', 'Render cancelled'));
      setAbortController(null);
      setCurrentQueueItem(null);
      setTimeout(() => startNextPendingRender(), 1000);
      return;
    }

    try {
      await cancelNativeRender(currentRenderId);
    } catch (error) {
      console.error('Error cancelling render:', error);
      setRenderStatus(t('videoRendering.cancelError', 'Error cancelling render'));
      // Force cleanup on error
      setIsRendering(false);
      setCurrentRenderId(null);
      setAbortController(null);
      setCurrentQueueItem(null);
      setTimeout(() => startNextPendingRender(), 1000);
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
            {t('videoRendering.upcomingFeatures', 'Upcoming features: crop, add text, logo, images, background music, ...')}
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
            handleVideoUpload={handleVideoUpload}
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
            isRendering={isRendering}
            currentQueueItem={currentQueueItem}
            onRender={handleRender}
            onCancelRender={handleCancelRender}
          />

          {/* Progress and errors are now shown in the queue items instead of here */}

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
