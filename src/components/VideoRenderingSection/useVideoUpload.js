import { useState, useRef, useEffect } from 'react';
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
 * Native picker, native drag-and-drop and selected-video-file state for the video rendering
 * section.
 *
 * @returns {{
 *   isDragging: boolean,
 *   selectedVideoFile: any,
 *   setSelectedVideoFile: Function,
 *   handleBrowseClick: Function,
 *   nativeDropZoneRef: { current: Element | null },
 * }}
 */
export const useVideoUpload = ({ onNativeVideoSelected } = {}) => {
  const [selectedVideoFile, setSelectedVideoFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const nativeDropZoneRef = useRef(null);

  const handleBrowseClick = async () => {
    try {
      const media = await selectNativeRenderVideo({ activate: onNativeVideoSelected });
      if (media) {
        setSelectedVideoFile(media);
      }
    } catch (error) {
      if (window.addToast) window.addToast(error.message, 'error', 8000);
    }
  };

  useEffect(() => {
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
    handleBrowseClick,
    nativeDropZoneRef,
  };
};
