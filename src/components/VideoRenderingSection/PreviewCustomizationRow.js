import NativeRenderPreview from '../previews/NativeRenderPreview';
import SubtitleCustomizationPanel from '../SubtitleCustomizationPanel';

/**
 * Second row: the resizable preview panel and the subtitle customization panel side by side. Pure
 * component — state, refs, and handlers come from props.
 *
 * The preview is the native compositor's own frame. It was `RemotionVideoPreview`, a second
 * implementation of the export composition maintained by hand in JavaScript; the render settings
 * that used to be folded into `subtitleCustomization` are passed as themselves now, because the
 * native path composes from the resolution and frame rate directly rather than reading them out of a
 * style object they never belonged in.
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
        <NativeRenderPreview
          ref={videoPlayerRef}
          videoFile={selectedVideoFile}
          subtitles={subtitles}
          narrationAudioUrl={(selectedNarration === 'generated' && isAlignedNarrationAvailable()) ? window.alignedNarrationCache?.url : null}
          subtitleCustomization={subtitleCustomization}
          resolution={renderSettings.resolution}
          frameRate={renderSettings.frameRate}
          trimStart={renderSettings.trimStart}
          trimEnd={renderSettings.trimEnd}
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
