import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/VideoCropControls.css';
import CanvasSettingsPill from './CanvasSettingsPill';
import useVideoTracking from './VideoCropControlsVideoTracking';
import useCropDrag from './VideoCropControlsCropDrag';
import useUIPositioning from './VideoCropControlsUIPositioning';

// Icons use currentColor to adapt to theme
const IconFree = () => (
  <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>crop_free</span>
);
const Icon169 = () => (
  <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>crop_16_9</span>
);
const Icon916 = () => (
  <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>crop_9_16</span>
);
const Icon11 = () => (
  <span className="material-symbols-rounded" style={{ fontSize: '18px' }}>crop_square</span>
);

const PRESET_ASPECT_RATIOS = [
  { label: 'Free', value: null, renderIcon: () => <IconFree /> },
  { label: '16:9', value: 16/9, renderIcon: () => <Icon169 /> },
  { label: '9:16', value: 9/16, renderIcon: () => <Icon916 /> },
  { label: '1:1', value: 1, renderIcon: () => <Icon11 /> },
];

const VideoCropControls = ({
  isEnabled = false,
  onToggle,
  cropSettings,
  onCropChange,
  onApply,
  onCancel,
  onClear,
  videoDimensions,
  hasAppliedCrop = false,
}) => {
  const { t } = useTranslation();
  const [selectedAspectRatio, setSelectedAspectRatio] = useState(null);
  const cropAreaRef = useRef(null);

  // Map between logical crop (original video space) and display crop (UI space respecting flips)
  const toDisplayCrop = useCallback((crop) => {
    if (!crop) return crop;
    const flipX = Boolean(crop.flipX);
    const flipY = Boolean(crop.flipY);
    const x = flipX ? 100 - (crop.x ?? 0) - (crop.width ?? 0) : (crop.x ?? 0);
    const y = flipY ? 100 - (crop.y ?? 0) - (crop.height ?? 0) : (crop.y ?? 0);
    return { ...crop, x, y };
  }, []);
  const fromDisplayCrop = useCallback((displayCrop) => {
    if (!displayCrop) return displayCrop;
    const flipX = Boolean(displayCrop.flipX);
    const flipY = Boolean(displayCrop.flipY);
    const x = flipX ? 100 - (displayCrop.x ?? 0) - (displayCrop.width ?? 0) : (displayCrop.x ?? 0);
    const y = flipY ? 100 - (displayCrop.y ?? 0) - (displayCrop.height ?? 0) : (displayCrop.y ?? 0);
    return { ...displayCrop, x, y };
  }, []);

  // Track the actual video element rect inside the preview panel
  const { videoRect } = useVideoTracking(isEnabled);

  // Crop-rectangle drag interaction + working crop state
  const { tempCrop, setTempCrop, handlers } = useCropDrag({
    cropAreaRef,
    selectedAspectRatio,
    videoDimensions,
    onCropChange,
    fromDisplayCrop,
    initialCrop: cropSettings,
  });
  const { handleMouseDown } = handlers;

  // Floating-UI positioning for the draggable crop controls
  const { uiPos, uiDrag, resetUiPositions, onUiMouseDown, suppressClickIfDragged, didDragRef } =
    useUIPositioning({ isEnabled, videoRect, cropAreaRef });

  useEffect(() => {
    // Normalize incoming crop settings, preserving any extra fields
    const normalized = {
      ...cropSettings,
      x: cropSettings.x ?? 0,
      y: cropSettings.y ?? 0,
      width: cropSettings.width ?? 100,
      height: cropSettings.height ?? 100,
      canvasBgMode: cropSettings.canvasBgMode ?? 'solid',
      canvasBgColor: cropSettings.canvasBgColor ?? '#000000',
      canvasBgBlur: cropSettings.canvasBgBlur ?? 24,
      // Ensure flip flags are always present on the normalized crop object
      flipX: cropSettings.flipX ?? false,
      flipY: cropSettings.flipY ?? false,
    };
    // Convert to display-space crop so UI manipulates flipped coordinates naturally
    setTempCrop(toDisplayCrop(normalized));
  }, [cropSettings, toDisplayCrop, setTempCrop]);

  // Calculate crop area dimensions based on aspect ratio
  const calculateCropDimensions = useCallback((aspectRatio) => {
    if (!videoDimensions) return cropSettings;

    const { width: videoWidth, height: videoHeight } = videoDimensions;
    let cropWidth, cropHeight;

    if (aspectRatio === null) {
      // Original aspect ratio - no crop
      return {
        x: 0,
        y: 0,
        width: 100,
        height: 100
      };
    } else if (aspectRatio === 'custom') {
      // Keep current crop
      return cropSettings;
    } else {
      // Calculate crop to maintain aspect ratio
      const videoAspect = videoWidth / videoHeight;

      if (aspectRatio > videoAspect) {
        // Crop is wider than video - fit width
        cropWidth = 100;
        cropHeight = (videoAspect / aspectRatio) * 100;
      } else {
        // Crop is taller than video - fit height
        cropHeight = 100;
        cropWidth = (aspectRatio / videoAspect) * 100;
      }

      // Center the crop
      const x = (100 - cropWidth) / 2;
      const y = (100 - cropHeight) / 2;

      return {
        x,
        y,
        width: cropWidth,
        height: cropHeight
      };
    }
  }, [videoDimensions, cropSettings]);

  const handleAspectRatioChange = (value) => {
    setSelectedAspectRatio(value);
    if (value !== 'custom') {
      const newLogical = calculateCropDimensions(value);
      // Preserve flip flags from current tempCrop
      newLogical.flipX = tempCrop?.flipX ?? false;
      newLogical.flipY = tempCrop?.flipY ?? false;
      const newDisplay = toDisplayCrop(newLogical);
      setTempCrop(newDisplay);
      onCropChange(fromDisplayCrop(newDisplay));
    }
  };

  // Reset selected aspect ratio when entering crop mode, reset UI positions when leaving
  useEffect(() => {
    if (isEnabled) {
      setSelectedAspectRatio(null);
    } else {
      resetUiPositions();
    }
  }, [isEnabled, resetUiPositions]);

  const handleApplyAndReset = () => {
    if (onApply) onApply();
    resetUiPositions();
  };

  return (
    <>
      {/* Crop control buttons - only show fixed position when NOT editing */}
      {!isEnabled && (
        <div style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          display: 'flex',
          gap: '8px',
          zIndex: 20,
        }}>
          <button
            className={`crop-toggle-btn ${hasAppliedCrop ? 'active' : ''}`}
            onClick={onToggle}
            title={hasAppliedCrop ? t('videoRendering.editCrop', 'Edit crop') : t('videoRendering.toggleCrop', 'Add crop')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>transform</span>
            {hasAppliedCrop && <span className="crop-indicator">✓</span>}
          </button>

          {hasAppliedCrop && (
            <button
              className="crop-clear-btn"
              onClick={onClear}
              title={t('videoRendering.clearCrop', 'Clear crop')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>close</span>
            </button>
          )}
        </div>
      )}

      {/* Crop overlay when enabled */}
      {isEnabled && (
        <>
          {/* Draggable crop toggle inside overlay when editing */}
          <div
            className="draggable-crop-toggle"
            style={{
              position: 'absolute',
              left: `${uiPos.toggle.xPct}%`,
              top: `${uiPos.toggle.yPct}%`,
              transform: 'translateX(-100%)',
              zIndex: 21,
              pointerEvents: 'auto',
              cursor: uiDrag?.kind === 'toggle' ? 'grabbing' : 'grab'
            }}
            onMouseDown={(e) => onUiMouseDown(e, 'toggle')}
            title={t('videoRendering.exitCrop', 'Exit crop')}
          >
            <button
              className={`crop-toggle-btn editing`}
              onClick={(e) => { suppressClickIfDragged(e); if (!didDragRef.current) { resetUiPositions(); onToggle && onToggle(); } }}
              onClickCapture={suppressClickIfDragged}
              title={t('videoRendering.exitCrop', 'Exit crop')}
              style={{ cursor: uiDrag?.kind === 'toggle' ? 'grabbing' : 'grab' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>transform</span>
            </button>
          </div>

          {/* Aspect ratio buttons - draggable */}
          <div className="crop-aspect-buttons" style={{
            position: 'absolute',
            left: `${uiPos.aspect.xPct}%`,
            top: `${uiPos.aspect.yPct}%`,
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: '8px',
            zIndex: 20,
            pointerEvents: 'auto',
            cursor: uiDrag?.kind === 'aspect' ? 'grabbing' : 'grab'
          }}
            onMouseDown={(e) => onUiMouseDown(e, 'aspect')}
            title={t('videoRendering.dragToReposition','Drag to reposition')}
          >
            {PRESET_ASPECT_RATIOS.map((preset) => (
              <button
                key={preset.label}
                className={`aspect-btn ${selectedAspectRatio === preset.value ? 'active' : ''}`}
                onClick={(e) => { suppressClickIfDragged(e); if (!didDragRef.current) handleAspectRatioChange(preset.value); }}
                onClickCapture={suppressClickIfDragged}
                title={preset.value == null ? t('videoRendering.free','Free') : preset.label}
                style={{ cursor: uiDrag?.kind === 'aspect' ? 'grabbing' : 'grab' }}
              >
                {preset.renderIcon && preset.renderIcon()}
                <span className="aspect-label">{preset.value == null ? t('videoRendering.free','Free') : preset.label}</span>
              </button>
            ))}
            {/* Separator + Flip buttons (moved next to aspect buttons) */}
            <div className="flip-group" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
              <div className="aspect-separator" />
              <button
                className={`flip-btn ${tempCrop.flipX ? 'active' : ''}`}
                onClick={(e) => { suppressClickIfDragged(e); if (!didDragRef.current) { e.stopPropagation(); const next = { ...tempCrop, flipX: !tempCrop.flipX }; setTempCrop(next); onCropChange(fromDisplayCrop(next)); } }}
                onClickCapture={suppressClickIfDragged}
                title={t('videoRendering.flipHorizontal','Flip horizontal')}
                aria-label={t('videoRendering.flipHorizontal','Flip horizontal')}
                style={{ cursor: uiDrag?.kind === 'aspect' ? 'grabbing' : 'grab' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>split_scene_left</span>
              </button>
              <button
                className={`flip-btn ${tempCrop.flipY ? 'active' : ''}`}
                onClick={(e) => { suppressClickIfDragged(e); if (!didDragRef.current) { e.stopPropagation(); const next = { ...tempCrop, flipY: !tempCrop.flipY }; setTempCrop(next); onCropChange(fromDisplayCrop(next)); } }}
                onClickCapture={suppressClickIfDragged}
                title={t('videoRendering.flipVertical','Flip vertical')}
                aria-label={t('videoRendering.flipVertical','Flip vertical')}
                style={{ cursor: uiDrag?.kind === 'aspect' ? 'grabbing' : 'grab' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>split_scene_up</span>
              </button>
            </div>
          </div>

          {/* Apply and Cancel buttons - draggable */}
          <div className="crop-action-buttons" style={{
            position: 'absolute',
            left: `${uiPos.actions.xPct}%`,
            top: `${uiPos.actions.yPct}%`,
            transform: 'translate(-50%, -100%)',
            display: 'flex',
            gap: '12px',
            zIndex: 20,
            pointerEvents: 'auto',
            cursor: uiDrag?.kind === 'actions' ? 'grabbing' : 'grab'
          }}
            onMouseDown={(e) => onUiMouseDown(e, 'actions')}
            title={t('videoRendering.dragToReposition','Drag to reposition')}
          >
            {/* Canvas settings - only when padding is detected */}
            <CanvasSettingsPill
              tempCrop={tempCrop}
              setTempCrop={setTempCrop}
              onCropChange={onCropChange}
              fromDisplayCrop={fromDisplayCrop}
            />

            <button
              className="crop-action-btn cancel"
              onClick={(e) => { suppressClickIfDragged(e); if (!didDragRef.current) onCancel && onCancel(e); }}
              onClickCapture={suppressClickIfDragged}
              style={{ cursor: uiDrag?.kind === 'actions' ? 'grabbing' : 'grab' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
              {t('videoRendering.cancel', 'Cancel')}
            </button>
            <button
              className="crop-action-btn apply"
              onClick={(e) => { suppressClickIfDragged(e); if (!didDragRef.current) handleApplyAndReset(); }}
              onClickCapture={suppressClickIfDragged}
              style={{ cursor: uiDrag?.kind === 'actions' ? 'grabbing' : 'grab' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>check</span>
              {t('videoRendering.applyCrop', 'Apply Crop')}
            </button>
          </div>

          {/* Crop overlay - positioned on actual video */}
          {videoRect && (
            <div
            ref={cropAreaRef}
            className="crop-overlay-container"
            style={{
              position: 'absolute',
              ...(videoRect ? {
                left: `${videoRect.left}px`,
                top: `${videoRect.top}px`,
                width: `${videoRect.width}px`,
                height: `${videoRect.height}px`,
              } : {
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
              }),
              pointerEvents: 'none',
              zIndex: 15
            }}
          >
            {/* Dark overlay for areas outside crop - supports padding (clamped to video bounds) */}
            {(() => {
              const clamp = (v) => Math.max(0, Math.min(100, v));
              const x0 = clamp(tempCrop.x);
              const y0 = clamp(tempCrop.y);
              const x1 = clamp(tempCrop.x + tempCrop.width);
              const y1 = clamp(tempCrop.y + tempCrop.height);
              const hasIntersection = x1 > x0 && y1 > y0;
              if (!hasIntersection) return null;
              return (
                <div
                  className="crop-overlay-mask"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    clipPath: `polygon(
                      0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                      ${x0}% ${y0}%,
                      ${x0}% ${y1}%,
                      ${x1}% ${y1}%,
                      ${x1}% ${y0}%,
                      ${x0}% ${y0}%
                    )`,
                    pointerEvents: 'none'
                  }}
                />
              );
            })()}

            {/* Crop area with handles */}
            <div
              className="crop-area"
              style={{
                position: 'absolute',
                left: `${tempCrop.x}%`,
                top: `${tempCrop.y}%`,
                width: `${tempCrop.width}%`,
                height: `${tempCrop.height}%`,
                pointerEvents: 'auto',
                cursor: 'default'
              }}
            >
              {/* Grid lines */}
              <div className="crop-grid">
                <div className="crop-grid-line horizontal" style={{ top: '33.33%' }} />
                <div className="crop-grid-line horizontal" style={{ top: '66.66%' }} />
                <div className="crop-grid-line vertical" style={{ left: '33.33%' }} />
                <div className="crop-grid-line vertical" style={{ left: '66.66%' }} />
              </div>

              {/* Corner handles */}
              <div className="crop-handle corner nw" onMouseDown={(e) => handleMouseDown(e, 'nw')} />
              <div className="crop-handle corner ne" onMouseDown={(e) => handleMouseDown(e, 'ne')} />
              <div className="crop-handle corner sw" onMouseDown={(e) => handleMouseDown(e, 'sw')} />
              <div className="crop-handle corner se" onMouseDown={(e) => handleMouseDown(e, 'se')} />

              {/* Edge handles */}
              <div className="crop-handle edge n" onMouseDown={(e) => handleMouseDown(e, 'n')} />
              <div className="crop-handle edge s" onMouseDown={(e) => handleMouseDown(e, 's')} />
              <div className="crop-handle edge e" onMouseDown={(e) => handleMouseDown(e, 'e')} />
              <div className="crop-handle edge w" onMouseDown={(e) => handleMouseDown(e, 'w')} />

              {/* Size display in center */}
              <div className="crop-size-display">
                {Math.round(tempCrop.width)}% × {Math.round(tempCrop.height)}%
              </div>
            </div>
          </div>
          )}
        </>
      )}
    </>
  );
};

export default VideoCropControls;
