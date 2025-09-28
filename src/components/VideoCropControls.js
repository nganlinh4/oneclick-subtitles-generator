import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/VideoCropControls.css';
import CustomDropdown from './common/CustomDropdown';
import StandardSlider from './common/StandardSlider';

// Icons use currentColor to adapt to theme
const IconFree = () => (
  <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M806-666v-59h-61q-26.37 0-43.19-18.2Q685-761.4 685-786q0-26 17.5-43t43.5-17h45q57.13 0 96.56 39.44Q927-767.13 927-710v45q0 26.37-17.51 43.19Q891.97-605 867-605q-26 0-43.5-17.5T806-666Zm-772 0v-44q0-57.13 39.44-96.56Q112.88-846 170-846h45q26.38 0 43.19 16.81T275-786.5q0 25.5-16.81 43.5T215-725h-60v60q0 26.37-17.51 43.19Q119.98-605 95-605q-26 0-43.5-17.5T34-666Zm757 552h-46q-26.37 0-43.19-17.5Q685-149 685-174.5t17.5-43Q720-235 746-235h60v-60q0-26.38 17.5-43.19t43-16.81q25.5 0 43 16.81T927-295v45q0 57.12-39.44 96.56Q848.13-114 791-114Zm-621 0q-57.12 0-96.56-39.44Q34-192.88 34-250v-45q0-26.38 17.5-43.19t43-16.81q25.5 0 43 16.81T155-295v60h60q26.38 0 43.19 17.51T275-175q0 26-16.81 43.5T215-114h-45Zm75-347v-38q0-58.4 38.8-97.2Q322.6-635 381-635h199q57 0 96.5 38.8T716-499v38q0 58.4-39.5 97.2Q637-325 580-325H381q-58.4 0-97.2-38.8Q245-402.6 245-461Zm121 15h229v-68H366v68Zm0 0v-68 68Z" />
  </svg>
);
const Icon169 = () => (
  <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M210-234q-57.12 0-96.56-40.14Q74-314.27 74-370v-220q0-55.72 39.44-95.86T210-726h540q57.13 0 96.56 40.14Q886-645.72 886-590v220q0 55.73-39.44 95.86Q807.13-234 750-234H210Zm0-136h540v-220H210v220Zm0 0v-220 220Z" />
  </svg>
);
const Icon916 = () => (
  <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M375-74q-57.12 0-96.56-39.44Q239-152.88 239-210v-540q0-57.13 39.44-96.56Q317.88-886 375-886h210q57.13 0 96.56 39.44Q721-807.13 721-750v540q0 57.12-39.44 96.56Q642.13-74 585-74H375Zm0-676v540h210v-540H375Zm0 0v540-540Z" />
  </svg>
);
const Icon11 = () => (
  <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M210-74q-57.12 0-96.56-39.44Q74-152.88 74-210v-540q0-57.13 39.44-96.56Q152.88-886 210-886h540q57.13 0 96.56 39.44Q886-807.13 886-750v540q0 57.12-39.44 96.56Q807.13-74 750-74H210Zm0-136h540v-540H210v540Zm0 0v-540 540Z" />
  </svg>
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


  useEffect(() => {
    // Normalize incoming crop settings, preserving any extra fields
    const normalized = {
      ...cropSettings,
      x: cropSettings.x ?? 0,
      y: cropSettings.y ?? 0,
      width: cropSettings.width ?? 100,
      height: cropSettings.height ?? 100,
      aspectRatio: cropSettings.aspectRatio ?? null,
      canvasBgMode: cropSettings.canvasBgMode ?? 'solid',
      canvasBgColor: cropSettings.canvasBgColor ?? '#000000',
      canvasBgBlur: cropSettings.canvasBgBlur ?? 24,
    };
    setTempCrop(normalized);
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
      onCropChange(tempCrop);
    }
  }, [isDragging, tempCrop, onCropChange]);

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


  // Reset floating UI positions when leaving crop mode
  useEffect(() => {
    if (!isEnabled) {
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
            <svg width="20" height="20" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M654-92v-79H306q-55.73 0-95.86-39.44Q170-249.88 170-307v-347H92q-29 0-48.5-20.2T24-722q0-29 19.5-48.5T92-790h78v-78q0-29 20.2-48.5T238-936q29 0 48.5 19.5T306-868v561h562q29 0 48.5 20.2T936-239q0 29-19.5 48.5T868-171h-78v79q0 27.6-20.2 47.8Q749.6-24 722-24q-29 0-48.5-20.2T654-92Zm0-295v-267H386v-136h268q57.13 0 96.56 39.44Q790-711.13 790-654v267H654Z"/>
            </svg>
            {hasAppliedCrop && <span className="crop-indicator">✓</span>}
          </button>

          {hasAppliedCrop && (
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
              <svg width="20" height="20" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M654-92v-79H306q-55.73 0-95.86-39.44Q170-249.88 170-307v-347H92q-29 0-48.5-20.2T24-722q0-29 19.5-48.5T92-790h78v-78q0-29 20.2-48.5T238-936q29 0 48.5 19.5T306-868v561h562q29 0 48.5 20.2T936-239q0 29-19.5 48.5T868-171h-78v79q0 27.6-20.2 47.8Q749.6-24 722-24q-29 0-48.5-20.2T654-92Zm0-295v-267H386v-136h268q57.13 0 96.56 39.44Q790-711.13 790-654v267H654Z"/>
              </svg>
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
                    onCropChange(next);
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
                      onCropChange(next);
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
                        onCropChange(next);
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
              <svg width="16" height="16" viewBox="0 -960 960 960" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M480-390 334-244q-20 20-45 19.5T245-245q-20-20-20-45t20-45l145-145-146-147q-20-20-19.5-45t20.5-45q19-20 44.5-20t45.5 20l145 146 146-146q20-20 45.5-20t44.5 20q20 20 20 45t-20 45L570-480l146 146q20 20 20 44.5T716-245q-19 20-44.5 20T626-245L480-390Z"/>
              </svg>
              {t('videoRendering.cancel', 'Cancel')}
            </button>
            <button
              className="crop-action-btn apply"
              onClick={(e) => { suppressClickIfDragged(e); if (!didDragRef.current) handleApplyAndReset(); }}
              onClickCapture={suppressClickIfDragged}
              style={{ cursor: uiDrag?.kind === 'actions' ? 'grabbing' : 'grab' }}
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