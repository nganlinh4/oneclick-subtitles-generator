import { useState, useRef, useEffect } from 'react';
import { isDesktopRuntime } from '../../platform/desktopRuntime';
import { sharedNativeMediaDropService } from '../../platform/mediaDropService';
import { isPhysicalPointInsideElement } from '../../platform/nativeMediaDropTarget';
import {
  claimMediaDrop,
  clearMedia,
  getSelectedMedia,
  isNativeMediaDescriptor,
  openMediaAsset,
  selectMedia,
} from '../../platform/mediaService';

/**
 * Undo a non-video native selection. Restoring only succeeds while the previous asset is owned by
 * the active project, so this stays best effort: a failed rollback must never replace the
 * actionable message the caller is about to raise.
 */
const rollbackNativeSelection = async (previous, restore, clear) => {
  try {
    if (isNativeMediaDescriptor(previous)) await restore(previous.assetId);
    else await clear();
  } catch {
    // The native session keeps the rejected selection; the caller's guidance still wins.
  }
};

export const selectNativeRenderVideo = async ({
  select = selectMedia,
  getCurrent = getSelectedMedia,
  restore = openMediaAsset,
  clear = clearMedia,
  activate = async () => undefined,
} = {}) => {
  const previous = await getCurrent();
  const selected = await select();
  if (selected === null) return null;
  if (isNativeMediaDescriptor(selected) && selected.type.startsWith('video/')) {
    try {
      await activate(selected);
      return selected;
    } catch (error) {
      await rollbackNativeSelection(previous, restore, clear);
      throw error;
    }
  }

  await rollbackNativeSelection(previous, restore, clear);
  throw new Error('Select a video file for rendering.');
};

export const claimNativeRenderVideo = async (offerId, {
  claim = claimMediaDrop,
  getCurrent = getSelectedMedia,
  restore = openMediaAsset,
  clear = clearMedia,
  activate = async () => undefined,
} = {}) => {
  const previous = await getCurrent();
  const selected = await claim(offerId);
  if (isNativeMediaDescriptor(selected) && selected.type.startsWith('video/')) {
    try {
      await activate(selected);
      return selected;
    } catch (error) {
      await rollbackNativeSelection(previous, restore, clear);
      throw error;
    }
  }
  await rollbackNativeSelection(previous, restore, clear);
  throw new Error('Drop a video file for rendering.');
};

/**
 * Drag-drop handlers + selected-video-file state for the video rendering section.
 *
 * @returns {{
 *   isDragging: boolean,
 *   selectedVideoFile: any,
 *   setSelectedVideoFile: Function,
 *   handleVideoUpload: Function,
 *   handleDragEnter: Function,
 *   handleDragLeave: Function,
 *   handleDragOver: Function,
 *   handleDrop: Function,
 * }}
 */
export const useVideoUpload = ({ onNativeVideoSelected } = {}) => {
  const [selectedVideoFile, setSelectedVideoFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const nativeDropZoneRef = useRef(null);

  // Handle video file upload
  const handleVideoUpload = async (event) => {
    const file = event.target.files[0];
    if (file) {
      setSelectedVideoFile(file);
    }
  };

  const handleBrowseClick = async () => {
    if (!isDesktopRuntime()) {
      document.getElementById('video-upload-input')?.click();
      return;
    }
    try {
      const media = await selectNativeRenderVideo({ activate: onNativeVideoSelected });
      if (media) {
        setSelectedVideoFile(media);
      }
    } catch (error) {
      if (window.addToast) window.addToast(error.message, 'error', 8000);
    }
  };

  // Drag and drop handlers (robust: use counter + global cleanup to avoid stuck overlay)
  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Increment counter for nested dragenter/dragleave events
    dragCounterRef.current = (dragCounterRef.current || 0) + 1;
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Decrement counter and only clear when no more entered elements remain
    dragCounterRef.current = Math.max(0, (dragCounterRef.current || 0) - 1);
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Reset counter and dragging state on drop
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      const videoFile = files.find(file => file.type && file.type.startsWith && file.type.startsWith('video/'));
      if (videoFile) {
        setSelectedVideoFile(videoFile);
      }
    }
  };

  // Ensure overlay is cleared if drag ends outside the component or window
  useEffect(() => {
    const onWindowDragEnd = () => {
      dragCounterRef.current = 0;
      setIsDragging(false);
    };
    const onWindowDrop = () => {
      dragCounterRef.current = 0;
      setIsDragging(false);
    };

    window.addEventListener('dragend', onWindowDragEnd);
    window.addEventListener('drop', onWindowDrop);

    return () => {
      window.removeEventListener('dragend', onWindowDragEnd);
      window.removeEventListener('drop', onWindowDrop);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    let cancelled = false;
    let subscription = null;
    let activeDragId = null;
    let lastSequence = 0;
    const inside = (position) => isPhysicalPointInsideElement(position, nativeDropZoneRef.current);
    const onEvent = (event) => {
      if (cancelled || event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      if (event.type === 'enter') activeDragId = event.dragId;
      else if (activeDragId !== null && event.dragId !== activeDragId) return;

      if (event.type === 'enter' || event.type === 'over') {
        setIsDragging(inside(event.position));
        return;
      }
      setIsDragging(false);
      if (event.type === 'leave') {
        activeDragId = null;
        return;
      }
      if (event.type !== 'drop' || !inside(event.position)) return;
      activeDragId = null;
      claimNativeRenderVideo(event.offerId, { activate: onNativeVideoSelected })
        .then((media) => {
          if (cancelled) return;
          setSelectedVideoFile(media);
        })
        .catch((error) => {
          if (!cancelled && window.addToast) window.addToast(error.message, 'error', 8000);
        });
    };
    sharedNativeMediaDropService.subscribe(onEvent, () => {
      if (!cancelled) setIsDragging(false);
    }).then((registered) => {
      if (cancelled) registered.unsubscribe().catch(() => {});
      else subscription = registered;
    }).catch(() => {
      if (!cancelled) setIsDragging(false);
    });
    return () => {
      cancelled = true;
      subscription?.unsubscribe().catch(() => {});
    };
  }, [onNativeVideoSelected]);

  return {
    isDragging,
    selectedVideoFile,
    setSelectedVideoFile,
    handleVideoUpload,
    handleBrowseClick,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    nativeDropZoneRef,
  };
};

export default useVideoUpload;
