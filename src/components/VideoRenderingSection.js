import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
import { useProjectRenderSceneControls } from './VideoRenderingSection/useProjectRenderSceneControls';
import { admitNativeRender } from './VideoRenderingSection/nativeRenderAdmission';
import VideoRenderingHeader from './VideoRenderingSection/VideoRenderingHeader';
import { usePanelResize } from './VideoRenderingSection/usePanelResize';
import { useAutoFill } from './VideoRenderingSection/useAutoFill';
import InputSelectionRow from './VideoRenderingSection/InputSelectionRow';
import RenderSettingsRow from './VideoRenderingSection/RenderSettingsRow';
import TrimTimelineRow from './VideoRenderingSection/TrimTimelineRow';
import PreviewCustomizationRow from './VideoRenderingSection/PreviewCustomizationRow';
import { cancelNativeRender, runNativeRender } from '../platform/renderService';
import { stageNativeRenderText } from './previews/native/exportTextStaging';
import { translatedSubtitlesForRender } from './previews/previewCueSelection';

const ACTIVE_RENDER_TOAST_DURATION_MS = 24 * 60 * 60 * 1000;

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
  const [, setError] = useState('');
  const [, setRenderAdmissionStage] = useState('idle');
  const [currentRenderId, setCurrentRenderId] = useState(null);
  const [abortController, setAbortController] = useState(null);
  const abortControllerRef = useRef(null);
  const activeNativeRenderIdRef = useRef(null);

  useEffect(() => {
    const key = 'native-video-render-status';
    if (!isRendering || !renderStatus) {
      window.removeToastByKey?.(key);
      return;
    }
    // The keyed toast is explicitly removed when the render stops. Give it a long timer so a
    // slow render cannot silently lose its only progress surface between phase changes.
    window.addToast?.(renderStatus, 'info', ACTIVE_RENDER_TOAST_DURATION_MS, key);
  }, [isRendering, renderStatus]);

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
    handleBrowseClick,
    nativeDropZoneRef,
  } = useVideoUpload({ onNativeVideoSelected });

  const {
    renderSceneStatus,
    flushProjectRenderScene,
    selectedSubtitles,
    selectedNarration,
    renderSettings,
    subtitleCustomization,
    cropSettings,
    setSelectedSubtitles,
    setSelectedNarration,
    setRenderSettings,
    setSubtitleCustomization,
    setCropSettings,
  } = useProjectRenderSceneControls();

  // *** FIX START ***
  // This effect resets the video duration state whenever a new video file is selected.
  // This ensures that the trim range is correctly re-initialized for the new video.
  useEffect(() => {
    // A new video means we don't know the duration yet.
    setVideoDuration(0);
  }, [selectedVideoFile]); // This dependency is stable; a new file is a new object.

  // A zero trim end is the durable spelling of "through the source end". The old duration effect
  // rewrote every restored trim when metadata arrived and could even write project A's duration into
  // project B after a switch. Only the slider needs a concrete endpoint for display; it receives a
  // derived value below and the project scene remains untouched until the user moves it.
  // *** FIX END ***

  // Narration availability + aligned-audio resolver + refresh action (extracted hook)
  const {
    isRefreshingNarration,
    alignedNarrationUrl,
    isAlignedNarrationAvailable,
    hasNarrationSegments,
    getNarrationArtifactId,
    handleRefreshNarration,
  } = useNarration({
    selectedNarration,
    narrationResults,
    subtitlesData,
    translatedSubtitles,
    selectedSubtitles,
  });

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

  // Note: isCollapsed state is not persisted - always starts collapsed like BackgroundImageGenerator

  // Get current subtitles based on selection
  const getSubtitlesForSource = (source) => {
    if (source === 'translated') {
      return translatedSubtitlesForRender(Array.isArray(translatedSubtitles) ? translatedSubtitles : [], subtitlesData);
    }
    return Array.isArray(subtitlesData) ? subtitlesData : [];
  };
  const getCurrentSubtitles = () => getSubtitlesForSource(selectedSubtitles);

  // Merge `patch` into the queue row with this id; every other row is left untouched.
  const patchQueueItem = (queueItemId, patch) => {
    setRenderQueue(prev => prev.map(item => (
      item.id === queueItemId ? { ...item, ...patch } : item
    )));
  };

  // Simple render function - allows queueing multiple renders
  const handleRender = async () => {
    setError('');
    setRenderStatus(t('videoRendering.validating', 'Checking render prerequisites...'));
    setRenderAdmissionStage('validating');
    let nativeSourceAsset;
    let nativeRenderRequest;
    let durableScene;
    let lyrics;
    try {
      ({ nativeSourceAsset, nativeRenderRequest, durableScene, lyrics } = await admitNativeRender({
        t,
        selectedVideoFile,
        flushProjectRenderScene,
        getSubtitlesForSource,
        getNarrationArtifactId,
        setStage: setRenderAdmissionStage,
      }));
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
      projectId: durableScene.projectId,
      sceneRevision: durableScene.sceneRevision,
      scene: durableScene,
      subtitles: durableScene.selectedSubtitles,
      settings: durableScene.renderSettings,
      customization: durableScene.customization,
      cropSettings: durableScene.crop,
      lyrics,
      narration: durableScene.selectedNarration,
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

      // Queue admission captured and durably flushed one complete project scene. Starting it may
      // never fall back to whichever project happens to be active now: that was the A→B corruption
      // path. A legacy/incomplete queue item is refused instead of silently rebuilt from live UI.
      if (!queueItem.nativeSourceAsset || !queueItem.nativeRenderRequest
          || queueItem.nativeRenderRequest.projectId !== queueItem.projectId
          || queueItem.nativeRenderRequest.sceneRevision !== queueItem.sceneRevision) {
        throw new Error(t(
          'videoRendering.invalidRenderConfiguration',
          'Check the selected video, subtitle timings, and render settings.',
        ));
      }
      const sourceAsset = queueItem.nativeSourceAsset;
      const nativeRequest = queueItem.nativeRenderRequest;
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
            activeNativeRenderIdRef.current = job.id;
            setCurrentRenderId(job.id);
            patchQueueItem(queueItem.id, { nativeJobId: job.id, nativeSourceAsset: sourceAsset });
          },
          onProgress: (event) => {
            if (!ownsRenderLease(renderOwner)) return;
            const progressPercent = Math.round(event.fractionMillionths / 10_000);
            setRenderProgress(progressPercent);
            patchQueueItem(queueItem.id, {
              progress: progressPercent,
              renderedFrames: event.renderedFrames,
              durationInFrames: event.durationInFrames,
              phase: event.phase,
            });
          },
        });
        if (!ownsRenderLease(renderOwner)) return;
        const { result } = completed;
        const completedAt = Date.now();
        ownQueuePlayback(result.playback.id);
        setRenderedVideoUrl(result.playback.playbackUrl);
        setRenderStatus(t('videoRendering.complete', 'Render complete!'));
        setRenderProgress(100);
        patchQueueItem(queueItem.id, {
          status: 'completed',
          progress: 100,
          completedAt,
          nativeJobId: completed.job.id,
          outputPath: result.playback.playbackUrl,
          outputPlaybackId: result.playback.id,
          outputAssetId: result.asset.id,
          outputArtifactId: result.artifactId,
          outputSizeBytes: result.asset.sizeBytes,
        });
      return;

    } catch (error) {
      if (!ownsRenderLease(renderOwner)) return;
      console.error('Render error:', error);

      // Check if this was an abort (cancellation)
      if (error.name === 'AbortError' || error.code === 'renderCancelled') {
        setRenderStatus(t('videoRendering.cancelled', 'Render cancelled'));
        setRenderProgress(0);

        // Only this generation may update its queue item.
        patchQueueItem(queueItem.id, { status: 'cancelled', progress: 0, error: null });
      } else {
        setError(error.message);
        setRenderStatus(t('videoRendering.failed', 'Render failed'));

        // Only this generation may update its queue item.
        patchQueueItem(queueItem.id, { status: 'failed', error: error.message });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        activeNativeRenderIdRef.current = null;
      }
    }
  };

  // Keep the ref current so the render-queue hook can invoke the latest handleStartRender.
  startRenderRef.current = handleStartRender;

  // Cancel rendering
  const handleCancelRender = async (queueItemId = null) => {
    const activeQueueItemId = typeof currentQueueItem === 'object'
      ? currentQueueItem?.id
      : currentQueueItem;
    if (queueItemId !== null && queueItemId !== activeQueueItemId) return false;

    // Before Rust admits a job, aborting the owned preparation signal is the authoritative
    // cancellation. Once a native job ID exists, only the typed native response may change UI.
    const activeController = abortControllerRef.current || abortController;
    const nativeRenderId = activeNativeRenderIdRef.current || currentRenderId;
    if (!nativeRenderId && activeController) {
      activeController.abort();
      setRenderStatus(t('videoRendering.cancelling', 'Cancelling render...'));
      patchQueueItem(activeQueueItemId, { status: 'cancelling' });
      return true;
    }

    if (!nativeRenderId) {
      return false;
    }

    try {
      const accepted = await cancelNativeRender(nativeRenderId);
      if (accepted.state === 'cancelling') {
        setRenderStatus(t('videoRendering.cancelling', 'Cancelling render...'));
        patchQueueItem(activeQueueItemId, { status: 'cancelling' });
      }
      return true;
    } catch (error) {
      console.error('Error cancelling render:', error);
      setRenderStatus(t('videoRendering.cancelError', 'Error cancelling render'));
      return false;
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
      >
      <VideoRenderingHeader
        isCollapsed={isCollapsed}
        isClickDisabled={isClickDisabled}
        onToggleCollapsed={() => {
          // Disable button for 2 seconds to prevent rapid clicking
          setIsClickDisabled(true);
          setTimeout(() => setIsClickDisabled(false), 2000);

          // A manual collapse sets userHasCollapsed; a manual expand resets it.
          const newCollapsedState = !isCollapsed;
          setIsCollapsed(newCollapsedState);
          setUserHasCollapsed(newCollapsedState);
        }}
      />

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
      ) : renderSceneStatus !== 'ready' ? null : (
        /* Expanded content */
        <div className="video-rendering-content">
          {/* First row: Video Input, Subtitle Source, and Narration Audio in one line */}
          <InputSelectionRow
            selectedVideoFile={selectedVideoFile}
            hasSubtitles={getCurrentSubtitles().length > 0}
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
            alignedNarrationUrl={alignedNarrationUrl}
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
