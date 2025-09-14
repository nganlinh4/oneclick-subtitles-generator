import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/VideoCropControls.css';

const IconFree = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 12h18M12 3v18" opacity=".6" />
    <path d="M8 5l-3 3M16 5l3 3M8 19l-3-3M16 19l3-3" />
  </svg>
);
const Icon169 = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="7" width="18" height="10" rx="2" /></svg>
);
const Icon916 = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="7" y="3" width="10" height="18" rx="2" /></svg>
);
const Icon11 = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="5" y="5" width="14" height="14" rx="2" /></svg>
);
const Icon45 = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="6" y="4.5" width="12" height="15" rx="2" /></svg>
);

const PRESET_ASPECT_RATIOS = [
  { label: 'Free', value: null, renderIcon: () => <IconFree /> },
  { label: '16:9', value: 16/9, renderIcon: () => <Icon169 /> },
  { label: '9:16', value: 9/16, renderIcon: () => <Icon916 /> },
  { label: '1:1', value: 1, renderIcon: () => <Icon11 /> },
  { label: '4:5', value: 4/5, renderIcon: () => <Icon45 /> },
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
  hasAppliedCrop = false
}) => {
  const { t } = useTranslation();
  const [selectedAspectRatio, setSelectedAspectRatio] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [tempCrop, setTempCrop] = useState(cropSettings);
  const cropAreaRef = useRef(null);
  const [videoRect, setVideoRect] = useState(null);

  useEffect(() => {
    setTempCrop(cropSettings);
  }, [cropSettings]);

  // Find and track the actual video element position
  useEffect(() => {
    if (!isEnabled) {
      setVideoRect(null);
      return;
    }

    let resizeObserverContainer = null;
    let resizeObserverWrapper = null;
    let resizeObserverVideo = null;
    let mutationObserver = null;
    let videoEl = null;
    let rafId = null;

    const setRectIfChanged = (newRect) => {
      setVideoRect((prev) => {
        if (
          prev &&
          Math.abs(prev.left - newRect.left) < 0.5 &&
          Math.abs(prev.top - newRect.top) < 0.5 &&
          Math.abs(prev.width - newRect.width) < 0.5 &&
          Math.abs(prev.height - newRect.height) < 0.5
        ) {
          return prev; // avoid unnecessary re-renders
        }
        return newRect;
      });
    };

    // Batch rect computations to one per animation frame
    const scheduleCompute = (container, video) => {
      if (!container || !video) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        computeAndSetRect(container, video);
        rafId = null;
      });
    };


    const computeAndSetRect = (containerElement, videoElement) => {
      if (!containerElement || !videoElement) return;
      const containerRect = containerElement.getBoundingClientRect();
      const videoRect = videoElement.getBoundingClientRect();
      const hasMeta = !!(videoElement.videoWidth && videoElement.videoHeight);

      const videoAspectRatio = hasMeta
        ? videoElement.videoWidth / videoElement.videoHeight
        : (videoRect.width > 0 && videoRect.height > 0 ? videoRect.width / videoRect.height : 1);
      const displayAspectRatio = (videoRect.width > 0 && videoRect.height > 0) ? (videoRect.width / videoRect.height) : videoAspectRatio;

      let actualVideoRect = {
        left: videoRect.left,
        top: videoRect.top,
        width: videoRect.width,
        height: videoRect.height,
      };

      if (hasMeta && Math.abs(videoAspectRatio - displayAspectRatio) > 0.01) {
        if (videoAspectRatio > displayAspectRatio) {
          const actualHeight = videoRect.width / videoAspectRatio;
          const letterboxHeight = (videoRect.height - actualHeight) / 2;
          actualVideoRect.top += letterboxHeight;
          actualVideoRect.height = actualHeight;
        } else {
          const actualWidth = videoRect.height * videoAspectRatio;
          const letterboxWidth = (videoRect.width - actualWidth) / 2;
          actualVideoRect.left += letterboxWidth;
          actualVideoRect.width = actualWidth;
        }
      }

      const newRect = {
        left: actualVideoRect.left - containerRect.left,
        top: actualVideoRect.top - containerRect.top,
        width: actualVideoRect.width,
        height: actualVideoRect.height,
      };
      setRectIfChanged(newRect);
    };

    const setupObservers = (containerElement) => {
      if (!containerElement) return;

      // Observe container size changes
      resizeObserverContainer = new ResizeObserver(() => {
        if (videoEl) scheduleCompute(containerElement, videoEl);
      });
      resizeObserverContainer.observe(containerElement);

	      // Observe wrapper changes (e.g., player wrapper / video wrapper)
	      const wrapperEl =
	        containerElement.querySelector('.video-wrapper') ||
	        containerElement.querySelector('.remotion-player') ||
	        containerElement.querySelector('[data-remotion-player]');
	      if (wrapperEl) {
	        resizeObserverWrapper = new ResizeObserver(() => {
	          if (videoEl) scheduleCompute(containerElement, videoEl);
	        });
	        resizeObserverWrapper.observe(wrapperEl);
	      }


      // Find or wait for the video element inside container
      const tryAttachVideo = () => {
        const found = containerElement.querySelector('video');
        if (!found) return false;

        videoEl = found;
        // Recompute on video metadata load
        const onMeta = () => computeAndSetRect(containerElement, videoEl);
        videoEl.addEventListener('loadedmetadata', onMeta, { once: true });

        // Observe video size changes
        resizeObserverVideo = new ResizeObserver(() => scheduleCompute(containerElement, videoEl));
        resizeObserverVideo.observe(videoEl);

        // Initial compute
        scheduleCompute(containerElement, videoEl);
        return true;
      };

      if (!tryAttachVideo()) {
        // Watch for DOM changes to attach when the video appears
        mutationObserver = new MutationObserver(() => {
          if (tryAttachVideo() && mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
          }
        });
        mutationObserver.observe(containerElement, { childList: true, subtree: true });
      }
    };

    const containerElement = document.querySelector('.video-preview-panel');
    setupObservers(containerElement);

    const onWindowResize = () => scheduleCompute(containerElement, videoEl);
    window.addEventListener('resize', onWindowResize);

    return () => {
      if (resizeObserverContainer) resizeObserverContainer.disconnect();
      if (resizeObserverVideo) resizeObserverVideo.disconnect();
      if (mutationObserver) mutationObserver.disconnect();
      if (resizeObserverWrapper) resizeObserverWrapper.disconnect();
      if (rafId) cancelAnimationFrame(rafId);

      window.removeEventListener('resize', onWindowResize);
    };
  }, [isEnabled]);

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
        height: 100,
        aspectRatio: videoWidth / videoHeight
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
        height: cropHeight,
        aspectRatio
      };
    }
  }, [videoDimensions, cropSettings]);

  const handleAspectRatioChange = (value) => {
    setSelectedAspectRatio(value);
    if (value !== 'custom') {
      const newCrop = calculateCropDimensions(value);
      setTempCrop(newCrop);
      onCropChange(newCrop);
    }
  };

  const handleMouseDown = (e, type) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    setDragType(type);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = useCallback((e) => {
    if (!isDragging || !dragType || !cropAreaRef.current) return;

    const rect = cropAreaRef.current.getBoundingClientRect();
    const deltaX = ((e.clientX - dragStart.x) / rect.width) * 100;
    const deltaY = ((e.clientY - dragStart.y) / rect.height) * 100;

    let newCrop = { ...tempCrop };

    switch (dragType) {
      case 'move':
        newCrop.x = Math.max(0, Math.min(100 - tempCrop.width, tempCrop.x + deltaX));
        newCrop.y = Math.max(0, Math.min(100 - tempCrop.height, tempCrop.y + deltaY));
        newCrop.width = tempCrop.width;
        newCrop.height = tempCrop.height;
        break;

      case 'nw':
        if (selectedAspectRatio && selectedAspectRatio !== 'custom' && selectedAspectRatio !== null) {
          // For aspect ratio, use the dominant movement direction
          const aspectRatio = selectedAspectRatio;
          const videoAspect = videoDimensions.width / videoDimensions.height;

          // Determine which direction moved more
          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);

          if (absDeltaX > absDeltaY) {
            // X movement is dominant
            newCrop.x = Math.max(0, Math.min(tempCrop.x + tempCrop.width - 10, tempCrop.x + deltaX));
            newCrop.width = tempCrop.x + tempCrop.width - newCrop.x;
            // Calculate height based on aspect ratio
            newCrop.height = newCrop.width / aspectRatio * videoAspect;
            newCrop.y = tempCrop.y + tempCrop.height - newCrop.height;
          } else {
            // Y movement is dominant
            newCrop.y = Math.max(0, Math.min(tempCrop.y + tempCrop.height - 10, tempCrop.y + deltaY));
            newCrop.height = tempCrop.y + tempCrop.height - newCrop.y;
            // Calculate width based on aspect ratio
            newCrop.width = newCrop.height * aspectRatio / videoAspect;
            newCrop.x = tempCrop.x + tempCrop.width - newCrop.width;
          }

          // Ensure within bounds
          newCrop.x = Math.max(0, newCrop.x);
          newCrop.y = Math.max(0, newCrop.y);
          newCrop.width = Math.min(100 - newCrop.x, newCrop.width);
          newCrop.height = Math.min(100 - newCrop.y, newCrop.height);
        } else {
          // Free resize
          newCrop.x = Math.max(0, Math.min(tempCrop.x + tempCrop.width - 10, tempCrop.x + deltaX));
          newCrop.y = Math.max(0, Math.min(tempCrop.y + tempCrop.height - 10, tempCrop.y + deltaY));
          newCrop.width = tempCrop.x + tempCrop.width - newCrop.x;
          newCrop.height = tempCrop.y + tempCrop.height - newCrop.y;
        }
        break;

      case 'ne':
        if (selectedAspectRatio && selectedAspectRatio !== 'custom' && selectedAspectRatio !== null) {
          const aspectRatio = selectedAspectRatio;
          const videoAspect = videoDimensions.width / videoDimensions.height;

          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);

          if (absDeltaX > absDeltaY) {
            // X movement is dominant
            newCrop.width = Math.max(10, Math.min(100 - tempCrop.x, tempCrop.width + deltaX));
            newCrop.x = tempCrop.x;
            // Calculate height based on aspect ratio
            newCrop.height = newCrop.width / aspectRatio * videoAspect;
            newCrop.y = tempCrop.y + tempCrop.height - newCrop.height;
          } else {
            // Y movement is dominant
            newCrop.y = Math.max(0, Math.min(tempCrop.y + tempCrop.height - 10, tempCrop.y + deltaY));
            newCrop.height = tempCrop.y + tempCrop.height - newCrop.y;
            // Calculate width based on aspect ratio
            newCrop.width = newCrop.height * aspectRatio / videoAspect;
            newCrop.x = tempCrop.x;
          }

          // Ensure within bounds
          newCrop.x = Math.max(0, newCrop.x);
          newCrop.y = Math.max(0, newCrop.y);
          newCrop.width = Math.min(100 - newCrop.x, newCrop.width);
          newCrop.height = Math.min(100 - newCrop.y, newCrop.height);
        } else {
          // Free resize
          newCrop.x = tempCrop.x;
          newCrop.y = Math.max(0, Math.min(tempCrop.y + tempCrop.height - 10, tempCrop.y + deltaY));
          newCrop.width = Math.max(10, Math.min(100 - tempCrop.x, tempCrop.width + deltaX));
          newCrop.height = tempCrop.y + tempCrop.height - newCrop.y;
        }
        break;

      case 'sw':
        if (selectedAspectRatio && selectedAspectRatio !== 'custom' && selectedAspectRatio !== null) {
          const aspectRatio = selectedAspectRatio;
          const videoAspect = videoDimensions.width / videoDimensions.height;

          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);

          if (absDeltaX > absDeltaY) {
            // X movement is dominant
            newCrop.x = Math.max(0, Math.min(tempCrop.x + tempCrop.width - 10, tempCrop.x + deltaX));
            newCrop.width = tempCrop.x + tempCrop.width - newCrop.x;
            // Calculate height based on aspect ratio
            newCrop.height = newCrop.width / aspectRatio * videoAspect;
            newCrop.y = tempCrop.y;
          } else {
            // Y movement is dominant
            newCrop.height = Math.max(10, Math.min(100 - tempCrop.y, tempCrop.height + deltaY));
            newCrop.y = tempCrop.y;
            // Calculate width based on aspect ratio
            newCrop.width = newCrop.height * aspectRatio / videoAspect;
            newCrop.x = tempCrop.x + tempCrop.width - newCrop.width;
          }

          // Ensure within bounds
          newCrop.x = Math.max(0, newCrop.x);
          newCrop.y = Math.max(0, newCrop.y);
          newCrop.width = Math.min(100 - newCrop.x, newCrop.width);
          newCrop.height = Math.min(100 - newCrop.y, newCrop.height);
        } else {
          // Free resize
          newCrop.x = Math.max(0, Math.min(tempCrop.x + tempCrop.width - 10, tempCrop.x + deltaX));
          newCrop.y = tempCrop.y;
          newCrop.width = tempCrop.x + tempCrop.width - newCrop.x;
          newCrop.height = Math.max(10, Math.min(100 - tempCrop.y, tempCrop.height + deltaY));
        }
        break;

      case 'se':
        if (selectedAspectRatio && selectedAspectRatio !== 'custom' && selectedAspectRatio !== null) {
          const aspectRatio = selectedAspectRatio;
          const videoAspect = videoDimensions.width / videoDimensions.height;

          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);

          if (absDeltaX > absDeltaY) {
            // X movement is dominant
            newCrop.width = Math.max(10, Math.min(100 - tempCrop.x, tempCrop.width + deltaX));
            // Calculate height based on aspect ratio
            newCrop.height = newCrop.width / aspectRatio * videoAspect;
            newCrop.x = tempCrop.x;
            newCrop.y = tempCrop.y;
          } else {
            // Y movement is dominant
            newCrop.height = Math.max(10, Math.min(100 - tempCrop.y, tempCrop.height + deltaY));
            // Calculate width based on aspect ratio
            newCrop.width = newCrop.height * aspectRatio / videoAspect;
            newCrop.x = tempCrop.x;
            newCrop.y = tempCrop.y;
          }

          // Ensure within bounds
          newCrop.width = Math.min(100 - newCrop.x, newCrop.width);
          newCrop.height = Math.min(100 - newCrop.y, newCrop.height);
        } else {
          // Free resize
          newCrop.x = tempCrop.x;
          newCrop.y = tempCrop.y;
          newCrop.width = Math.max(10, Math.min(100 - tempCrop.x, tempCrop.width + deltaX));
          newCrop.height = Math.max(10, Math.min(100 - tempCrop.y, tempCrop.height + deltaY));
        }
        break;

      case 'n':
        newCrop.x = tempCrop.x;
        newCrop.y = Math.max(0, Math.min(tempCrop.y + tempCrop.height - 10, tempCrop.y + deltaY));
        newCrop.width = tempCrop.width;
        newCrop.height = tempCrop.y + tempCrop.height - newCrop.y;
        break;

      case 's':
        newCrop.x = tempCrop.x;
        newCrop.y = tempCrop.y;
        newCrop.width = tempCrop.width;
        newCrop.height = Math.max(10, Math.min(100 - tempCrop.y, tempCrop.height + deltaY));
        break;

      case 'e':
        newCrop.x = tempCrop.x;
        newCrop.y = tempCrop.y;
        newCrop.width = Math.max(10, Math.min(100 - tempCrop.x, tempCrop.width + deltaX));
        newCrop.height = tempCrop.height;
        break;

      case 'w':
        newCrop.x = Math.max(0, Math.min(tempCrop.x + tempCrop.width - 10, tempCrop.x + deltaX));
        newCrop.y = tempCrop.y;
        newCrop.width = tempCrop.x + tempCrop.width - newCrop.x;
        newCrop.height = tempCrop.height;
        break;

      default:
        break;
    }

    // Ensure minimum size
    newCrop.width = Math.max(10, newCrop.width);
    newCrop.height = Math.max(10, newCrop.height);

    setTempCrop(newCrop);
    setDragStart({ x: e.clientX, y: e.clientY });
  }, [isDragging, dragType, dragStart, tempCrop, selectedAspectRatio, videoDimensions]);

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      setDragType(null);
      onCropChange(tempCrop);
      if (selectedAspectRatio !== 'custom' && selectedAspectRatio !== null) {
        setSelectedAspectRatio('custom');
      }
    }
  }, [isDragging, tempCrop, onCropChange, selectedAspectRatio]);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = dragType === 'move' ? 'move' : 'nwse-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, handleMouseMove, handleMouseUp, dragType]);

  const handleReset = () => {
    const resetCrop = {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      aspectRatio: null
    };
    setTempCrop(resetCrop);
    onCropChange(resetCrop);
    setSelectedAspectRatio(null);
  };

  return (
    <>
      {/* Crop control buttons - positioned at top-right of video */}
      <div style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        display: 'flex',
        gap: '8px',
        zIndex: 20,
      }}>
        <button
          className={`crop-toggle-btn ${isEnabled ? 'editing' : hasAppliedCrop ? 'active' : ''}`}
          onClick={onToggle}
          title={hasAppliedCrop ? t('videoRendering.editCrop', 'Edit crop') : t('videoRendering.toggleCrop', 'Add crop')}
        >
          <svg width="20" height="20" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M475 13Q299.99 13 168.49-94 37-201-2-365q-6-21.36 8.5-39.18t37-21.32q21.34-2.5 40.97 9.84T110-382q29 103 108.5 179T405-107l-9-10q-15-15-15-33t15-34q15-16 34.5-16.5T465-186L611.55-39.45q7.45 7.45 4.7 20.18Q613.5-6.53 601.39-2.7 565 5 533 9q-32 4-58 4ZM374-277q-39.89 0-68.44-28.56Q277-334.11 277-374v-212h-49q-19.28 0-33.64-14.29T180-634.79q0-19.78 14.65-34Q209.3-683 229-683h48v-49q0-19.27 14.37-33.64Q305.74-780 326.07-780q19.91 0 33.92 14.36Q374-751.27 374-732v358h348q19.87 0 33.94 13.89Q770-346.23 770-326.61 770-307 755.94-292q-14.07 15-33.94 15h-39v49q0 19.28-14.01 33.64-14 14.36-33.8 14.36-19.79 0-34.49-14.65Q586-209.3 586-229v-48H374Zm212-154v-155H431v-97h155q41.29 0 69.14 27.86Q683-627.29 683-586v155h-97ZM485-973q175.01 0 306.51 108Q923-757 962-594q6 20.98-8.5 38.99t-37.23 20.51q-22.74 2.5-41.56-10.34Q855.9-557.68 850-578q-29-103-108.5-179T555-854l9 11q15 15 15 32.5T564-777q-15 16-34.5 17T495-775L348.45-920.55Q341-929 343.82-941.6q2.82-12.6 15.18-16.4 36-8 68-11.5t58-3.5Z"/>
          </svg>
          {hasAppliedCrop && !isEnabled && (
            <span className="crop-indicator">✓</span>
          )}
        </button>

        {/* Clear crop button - only show when crop is applied and not editing */}
        {hasAppliedCrop && !isEnabled && (
          <button
            className="crop-clear-btn"
            onClick={onClear}
            title={t('videoRendering.clearCrop', 'Clear crop')}
          >
            <svg width="20" height="20" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M480-390 334-244q-20 20-45 19.5T245-245q-20-20-20-45t20-45l145-145-146-147q-20-20-19.5-45t20.5-45q19-20 44.5-20t45.5 20l145 146 146-146q20-20 45.5-20t44.5 20q20 20 20 45t-20 45L570-480l146 146q20 20 20 44.5T716-245q-19 20-44.5 20T626-245L480-390Z"/>
            </svg>
          </button>
        )}
      </div>

      {/* Crop overlay when enabled */}
      {isEnabled && (
        <>
          {/* Aspect ratio buttons - positioned at top of video */}
          <div className="crop-aspect-buttons" style={{
            position: 'absolute',
            top: '10px',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: '8px',
            zIndex: 20,
          }}>
            {PRESET_ASPECT_RATIOS.map((preset) => (
              <button
                key={preset.label}
                className={`aspect-btn ${selectedAspectRatio === preset.value ? 'active' : ''}`}
                onClick={() => handleAspectRatioChange(preset.value)}
                title={preset.label}
              >
                {preset.renderIcon && preset.renderIcon()}
                <span className="aspect-label">{preset.label}</span>
              </button>
            ))}
          </div>

          {/* Apply and Cancel buttons */}
          <div className="crop-action-buttons" style={{
            position: 'absolute',
            bottom: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: '12px',
            zIndex: 20,
          }}>
            <button
              className="crop-action-btn cancel"
              onClick={onCancel}
            >
              <svg width="16" height="16" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M480-390 334-244q-20 20-45 19.5T245-245q-20-20-20-45t20-45l145-145-146-147q-20-20-19.5-45t20.5-45q19-20 44.5-20t45.5 20l145 146 146-146q20-20 45.5-20t44.5 20q20 20 20 45t-20 45L570-480l146 146q20 20 20 44.5T716-245q-19 20-44.5 20T626-245L480-390Z"/>
              </svg>
              {t('videoRendering.cancel', 'Cancel')}
            </button>
            <button
              className="crop-action-btn apply"
              onClick={onApply}
            >
              <svg width="16" height="16" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="m389-408 281-281q19-19 46-19t46 18.79q19 18.79 19 45.58t-18.61 45.4L435-272q-18.73 19-45.36 19Q363-253 344-272L200-415q-19-19.73-19.5-45.87Q180-487 198.79-506q19.79-20 46.17-20 26.37 0 45.04 20l99 98Z"/>
              </svg>
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
            {/* Dark overlay for areas outside crop */}
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
                  ${tempCrop.x}% ${tempCrop.y}%,
                  ${tempCrop.x}% ${tempCrop.y + tempCrop.height}%,
                  ${tempCrop.x + tempCrop.width}% ${tempCrop.y + tempCrop.height}%,
                  ${tempCrop.x + tempCrop.width}% ${tempCrop.y}%,
                  ${tempCrop.x}% ${tempCrop.y}%
                )`,
                pointerEvents: 'none'
              }}
            />

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
                cursor: 'move'
              }}
              onMouseDown={(e) => handleMouseDown(e, 'move')}
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