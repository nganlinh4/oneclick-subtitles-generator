import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/VideoCropControls.css';
import CustomDropdown from './common/CustomDropdown';
import StandardSlider from './common/StandardSlider';

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
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [tempCrop, setTempCrop] = useState(cropSettings);
  const cropAreaRef = useRef(null);
  const [videoRect, setVideoRect] = useState(null);

  const dragBaseRectRef = useRef(null);
  const dragBaseCropRef = useRef(null);

  const dragBaseDisplayCropRef = useRef(null);

  // Draggable UI positions (percentages within videoRect)
  const defaultUiPos = {
    aspect: { xPct: 50, yPct: 2 },
    toggle: { xPct: 96, yPct: 2 },
    actions: { xPct: 50, yPct: 96 }
  };
  const [uiPos, setUiPos] = useState(defaultUiPos);
  const resetUiPositions = useCallback(() => { setUiPos(defaultUiPos); uiInitializedRef.current = false; }, []);
  const [uiDrag, setUiDrag] = useState(null);
  const uiInitializedRef = useRef(false);
  const didDragRef = useRef(false);

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
  }, [cropSettings, toDisplayCrop]);

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

  const handleMouseDown = (e, type) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    setDragType(type);
    setDragStart({ x: e.clientX, y: e.clientY });
    // Capture base rect and base crop to make deltas stable even if preview resizes during drag
    if (cropAreaRef.current) {
      dragBaseRectRef.current = cropAreaRef.current.getBoundingClientRect();
    }
    dragBaseCropRef.current = { ...tempCrop };
  };

  const handleMouseMove = useCallback((e) => {
    if (!isDragging || !dragType || !cropAreaRef.current) return;

    const baseRect = dragBaseRectRef.current || cropAreaRef.current.getBoundingClientRect();
    const baseCrop = dragBaseCropRef.current || tempCrop;
    const deltaX = ((e.clientX - dragStart.x) / baseRect.width) * 100;
    const deltaY = ((e.clientY - dragStart.y) / baseRect.height) * 100;

    let newCrop = { ...tempCrop };

    switch (dragType) {

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
            newCrop.x = baseCrop.x + deltaX;
            newCrop.width = baseCrop.x + baseCrop.width - newCrop.x;
            // Calculate height based on aspect ratio
            newCrop.height = newCrop.width / aspectRatio * videoAspect;
            newCrop.y = baseCrop.y + baseCrop.height - newCrop.height;
          } else {
            // Y movement is dominant
            newCrop.y = baseCrop.y + deltaY;
            newCrop.height = baseCrop.y + baseCrop.height - newCrop.y;
            // Calculate width based on aspect ratio
            newCrop.width = newCrop.height * aspectRatio / videoAspect;
            newCrop.x = baseCrop.x + baseCrop.width - newCrop.width;
          }


        } else {
          // Free resize
          newCrop.x = baseCrop.x + deltaX;
          newCrop.y = baseCrop.y + deltaY;
          newCrop.width = baseCrop.x + baseCrop.width - newCrop.x;
          newCrop.height = baseCrop.y + baseCrop.height - newCrop.y;
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
            newCrop.width = baseCrop.width + deltaX;
            newCrop.x = baseCrop.x;
            // Calculate height based on aspect ratio
            newCrop.height = newCrop.width / aspectRatio * videoAspect;
            newCrop.y = baseCrop.y + baseCrop.height - newCrop.height;
          } else {
            // Y movement is dominant
            newCrop.y = baseCrop.y + deltaY;
            newCrop.height = baseCrop.y + baseCrop.height - newCrop.y;
            // Calculate width based on aspect ratio
            newCrop.width = newCrop.height * aspectRatio / videoAspect;
            newCrop.x = baseCrop.x;
          }
        } else {
          // Free resize
          newCrop.x = baseCrop.x;
          newCrop.y = baseCrop.y + deltaY;
          newCrop.width = baseCrop.width + deltaX;
          newCrop.height = baseCrop.y + baseCrop.height - newCrop.y;
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
            newCrop.x = baseCrop.x + deltaX;
            newCrop.width = baseCrop.x + baseCrop.width - newCrop.x;
            // Calculate height based on aspect ratio
            newCrop.height = newCrop.width / aspectRatio * videoAspect;
            newCrop.y = baseCrop.y;
          } else {
            // Y movement is dominant
            newCrop.height = baseCrop.height + deltaY;
            newCrop.y = baseCrop.y;
            // Calculate width based on aspect ratio
            newCrop.width = newCrop.height * aspectRatio / videoAspect;
            newCrop.x = baseCrop.x + baseCrop.width - newCrop.width;
          }


        } else {
          // Free resize
          newCrop.x = baseCrop.x + deltaX;
          newCrop.y = baseCrop.y;
          newCrop.width = baseCrop.x + baseCrop.width - newCrop.x;
          newCrop.height = baseCrop.height + deltaY;
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
            newCrop.width = baseCrop.width + deltaX;
            // Calculate height based on aspect ratio
            newCrop.height = newCrop.width / aspectRatio * videoAspect;
            newCrop.x = baseCrop.x;
            newCrop.y = baseCrop.y;
          } else {
            // Y movement is dominant
            newCrop.height = baseCrop.height + deltaY;
            // Calculate width based on aspect ratio
            newCrop.width = newCrop.height * aspectRatio / videoAspect;
            newCrop.x = baseCrop.x;
            newCrop.y = baseCrop.y;
          }


        } else {
          // Free resize
          newCrop.x = baseCrop.x;
          newCrop.y = baseCrop.y;
          newCrop.width = baseCrop.width + deltaX;
          newCrop.height = baseCrop.height + deltaY;
        }
        break;

      case 'n':
        if (typeof selectedAspectRatio === 'number') {
          const aspectRatio = selectedAspectRatio;
          const videoAspect = videoDimensions.width / videoDimensions.height;
          const centerX = baseCrop.x + baseCrop.width / 2;
          const newHeight = baseCrop.height - deltaY;
          const newWidth = newHeight * aspectRatio / videoAspect;
          newCrop.y = baseCrop.y + deltaY;
          newCrop.height = newHeight;
          newCrop.width = newWidth;
          newCrop.x = centerX - newWidth / 2;
        } else {
          newCrop.x = baseCrop.x;
          newCrop.y = baseCrop.y + deltaY;
          newCrop.width = baseCrop.width;
          newCrop.height = baseCrop.y + baseCrop.height - newCrop.y;
        }
        break;

      case 's':
        if (typeof selectedAspectRatio === 'number') {
          const aspectRatio = selectedAspectRatio;
          const videoAspect = videoDimensions.width / videoDimensions.height;
          const centerX = baseCrop.x + baseCrop.width / 2;
          const newHeight = baseCrop.height + deltaY;
          const newWidth = newHeight * aspectRatio / videoAspect;
          newCrop.y = baseCrop.y;
          newCrop.height = newHeight;
          newCrop.width = newWidth;
          newCrop.x = centerX - newWidth / 2;
        } else {
          newCrop.x = baseCrop.x;
          newCrop.y = baseCrop.y;
          newCrop.width = baseCrop.width;
          newCrop.height = baseCrop.height + deltaY;
        }
        break;

      case 'e':
        if (typeof selectedAspectRatio === 'number') {
          const aspectRatio = selectedAspectRatio;
          const videoAspect = videoDimensions.width / videoDimensions.height;
          const centerY = baseCrop.y + baseCrop.height / 2;
          const newWidth = baseCrop.width + deltaX;
          const newHeight = newWidth / aspectRatio * videoAspect;
          newCrop.x = baseCrop.x;
          newCrop.width = newWidth;
          newCrop.height = newHeight;
          newCrop.y = centerY - newHeight / 2;
        } else {
          newCrop.x = baseCrop.x;
          newCrop.y = baseCrop.y;
          newCrop.width = baseCrop.width + deltaX;
          newCrop.height = baseCrop.height;
        }
        break;

      case 'w':
        if (typeof selectedAspectRatio === 'number') {
          const aspectRatio = selectedAspectRatio;
          const videoAspect = videoDimensions.width / videoDimensions.height;
          const centerY = baseCrop.y + baseCrop.height / 2;
          const newWidth = baseCrop.width - deltaX;
          const newHeight = newWidth / aspectRatio * videoAspect;
          newCrop.x = baseCrop.x + deltaX;
          newCrop.width = newWidth;
          newCrop.height = newHeight;
          newCrop.y = centerY - newHeight / 2;
        } else {
          newCrop.x = baseCrop.x + deltaX;
          newCrop.y = baseCrop.y;
          newCrop.width = baseCrop.x + baseCrop.width - newCrop.x;
          newCrop.height = baseCrop.height;
        }
        break;

      default:
        break;
    }

    // Ensure minimum size
    newCrop.width = Math.max(10, newCrop.width);
    newCrop.height = Math.max(10, newCrop.height);

    setTempCrop(newCrop);
  }, [isDragging, dragType, dragStart, tempCrop, selectedAspectRatio, videoDimensions]);

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      setDragType(null);
      // Convert display-space crop back to logical crop for consumers
      onCropChange(fromDisplayCrop(tempCrop));
    }
  }, [isDragging, tempCrop, onCropChange, fromDisplayCrop]);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = (dragType === 'n' || dragType === 's')
        ? 'ns-resize'
        : (dragType === 'e' || dragType === 'w')
          ? 'ew-resize'
          : 'nwse-resize';
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

  // Dragging for floating UI during crop mode
  const onUiMouseDown = (e, kind) => {
    if (!isEnabled) return;
    if (!cropAreaRef.current) return;
    // Do not start group-dragging when interacting with elements marked as no-ui-drag (e.g., blur slider)
    const tgt = e.target;
    if (tgt && typeof tgt.closest === 'function' && tgt.closest('.no-ui-drag')) {
      return;
    }
    didDragRef.current = false;
    setUiDrag({
      kind,
      startX: e.clientX,
      startY: e.clientY,
      startPos: { ...(uiPos[kind] || { xPct: 50, yPct: 50 }) }
    });
  };

  useEffect(() => {
    if (!uiDrag) return;
    const onMove = (e) => {
      if (!cropAreaRef.current) return;
      const rect = cropAreaRef.current.getBoundingClientRect();
      const dxPx = (e.clientX - uiDrag.startX);
      const dyPx = (e.clientY - uiDrag.startY);
      const moved = Math.abs(dxPx) > 3 || Math.abs(dyPx) > 3;
      if (moved) didDragRef.current = true;
      const dxPct = rect.width ? (dxPx / rect.width) * 100 : 0;
      const dyPct = rect.height ? (dyPx / rect.height) * 100 : 0;
      setUiPos((prev) => {
        const start = uiDrag.startPos || prev[uiDrag.kind] || { xPct: 50, yPct: 50 };
        const next = {
          ...prev,
          [uiDrag.kind]: {
            xPct: Math.max(0, Math.min(100, start.xPct + dxPct)),
            yPct: Math.max(0, Math.min(100, start.yPct + dyPct)),
          }
        };
        return next;
      });
    };
    const onUp = () => setUiDrag(null);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [uiDrag]);
  const suppressClickIfDragged = (e) => {
    if (didDragRef.current) {
      e.preventDefault();
      e.stopPropagation();
      didDragRef.current = false;
    }
  };
  // Initialize default draggable positions to match old fixed positions when overlay opens
  useEffect(() => {
    if (isEnabled && videoRect && !uiInitializedRef.current) {
      const vw = videoRect.width || 1;
      const vh = videoRect.height || 1;
      setUiPos({
        aspect: { xPct: 50, yPct: (14 / vh) * 100 }, // top:14px, centered
        toggle: { xPct: ((vw - 10) / vw) * 100, yPct: (10 / vh) * 100 }, // right:10px, top:10px
        actions: { xPct: 50, yPct: ((vh - 20) / vh) * 100 } // bottom:20px, centered
      });
      uiInitializedRef.current = true;
    }
  }, [isEnabled, videoRect]);


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
            {(tempCrop && (
              tempCrop.width > 100 || tempCrop.height > 100 || tempCrop.x < 0 || tempCrop.y < 0 ||
              (tempCrop.x + tempCrop.width) > 100 || (tempCrop.y + tempCrop.height) > 100
            )) && (
              <div className="canvas-settings-pill" style={{
                position: 'absolute',
                bottom: '72px',
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                background: 'var(--md-surface)',
                color: 'var(--md-on-surface)',
                border: '1px solid var(--md-outline-variant)',
                borderRadius: '999px',
                padding: '6px 18px',
                whiteSpace: 'nowrap',
                boxShadow: 'var(--md-elevation-level2)',
                zIndex: 20
              }}>
                <span style={{ fontSize: 12, opacity: 0.8 }}>{t('videoRendering.canvas','Canvas')}:</span>
                <CustomDropdown
                  value={tempCrop.canvasBgMode ?? 'solid'}
                  onChange={(value) => {
                    const next = { ...tempCrop, canvasBgMode: value };
                    setTempCrop(next);
                    onCropChange(fromDisplayCrop(next));
                  }}
                  options={[
                    { value: 'solid', label: t('videoRendering.solidCanvas','Solid') },
                    { value: 'blur', label: t('videoRendering.blurredVideo','Blurred video') },
                  ]}
                />
                {(tempCrop.canvasBgMode ?? 'solid') === 'solid' && (
                  <input
                    type="color"
                    value={tempCrop.canvasBgColor ?? '#000000'}
                    onChange={(e) => {
                      const next = { ...tempCrop, canvasBgColor: e.target.value };
                      setTempCrop(next);
                      onCropChange(fromDisplayCrop(next));
                    }}
                    title={t('videoRendering.canvasColor','Canvas color')}
                    className="color-picker"
                  />
                )}
                {(tempCrop.canvasBgMode ?? 'solid') === 'blur' && (
                  <div className="canvas-blur-slider no-ui-drag" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'default' }} onMouseDown={(e) => e.stopPropagation()}>
                    <span style={{ fontSize: 12, opacity: 0.8 }}>{t('videoRendering.blurIntensity', 'Blur')}</span>
                    <StandardSlider
                      value={tempCrop.canvasBgBlur ?? 24}
                      onChange={(value) => {
                        const next = { ...tempCrop, canvasBgBlur: parseInt(value) };
                        setTempCrop(next);
                        onCropChange(fromDisplayCrop(next));
                      }}
                      min={0}
                      max={60}
                      step={1}
                      orientation="Horizontal"
                      size="XSmall"
                      state="Enabled"
                      showValueIndicator={false}
                      showIcon={false}
                      showStops={false}
                      style={{ width: 140 }}
                      ariaLabel={t('videoRendering.blurIntensity', 'Blur')}
                    />
                    <span style={{ fontSize: 12, opacity: 0.7, minWidth: 28, textAlign: 'right' }}>
                      {(tempCrop.canvasBgBlur ?? 24)}px
                    </span>
                  </div>
                )}

              </div>
            )}


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