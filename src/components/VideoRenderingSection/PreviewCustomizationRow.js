import RemotionVideoPreview from '../RemotionVideoPreview';
import SubtitleCustomizationPanel from '../SubtitleCustomizationPanel';

/**
 * Second row: the resizable Remotion preview panel and the subtitle customization
 * panel side by side. Pure component — state, refs, and handlers come from props.
 */
const PreviewCustomizationRow = ({
  containerRef,
  leftPanelWidth,
  handleMouseDown,
  videoPlayerRef,
  selectedVideoFile,
  subtitles,
  selectedNarration,
  isAlignedNarrationAvailable,
  subtitleCustomization,
  setSubtitleCustomization,
  renderSettings,
  cropSettings,
  setCropSettings,
  setVideoDuration,
}) => {
  return (
    <div
      ref={containerRef}
      className="preview-customization-row"
      style={{
        '--left-panel-width': `${leftPanelWidth}%`,
        '--right-panel-width': `${100 - leftPanelWidth}%`
      }}
    >
      {/* Video Preview Panel */}
      <div
        className="video-preview-panel"
        style={{ flex: `0 0 ${leftPanelWidth}%` }}
        tabIndex={0}
      >
        <RemotionVideoPreview
          ref={videoPlayerRef}
          videoFile={selectedVideoFile}
          subtitles={subtitles}
          narrationAudioUrl={(selectedNarration === 'generated' && isAlignedNarrationAvailable()) ? window.alignedNarrationCache?.url : null}
          subtitleCustomization={{
            ...subtitleCustomization,
            resolution: renderSettings.resolution,
            frameRate: renderSettings.frameRate
          }}
          originalAudioVolume={renderSettings.originalAudioVolume}
          narrationVolume={selectedNarration === 'none' ? 0 : renderSettings.narrationVolume}
          cropSettings={cropSettings}
          onCropChange={setCropSettings}
          onDurationChange={setVideoDuration}
        />
      </div>

      {/* Resizable Divider */}
      <div
        className="panel-resizer"
        onMouseDown={handleMouseDown}
      ></div>

      {/* Subtitle Customization Panel */}
      <div
        className="customization-panel"
        style={{ flex: `0 0 ${100 - leftPanelWidth}%` }}
      >
        <SubtitleCustomizationPanel
          customization={subtitleCustomization}
          onChange={setSubtitleCustomization}
        />
      </div>
    </div>
  );
};

export default PreviewCustomizationRow;
