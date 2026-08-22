/**
 * What a preview surface must know before it can build the shared preview/export scene: which
 * project and media it belongs to, and how large the decoded source actually is.
 *
 * BINDING IS NOT DECORATION. Every request carries the project and the media it was issued for, so
 * asynchronous source preparation that finishes after a project switch can be recognised as stale
 * and dropped. Without it project A can repaint project B with plausible but incorrect pixels.
 *
 * The source size is read from the `<video>` element rather than from the media record, because the
 * composition width is derived from the source aspect and the element is the only thing that has
 * actually decoded the file. Until it has, there is no honest composition size and the surface stays
 * dormant instead of guessing 16:9.
 *
 * A browser session with no desktop runtime remains dormant. A selected desktop source that fails
 * to resolve is returned as a typed binding error; silently collapsing that case to dormancy left
 * customers with subtitle rows and an unexplained raw-video preview.
 */

import { useEffect, useState } from 'react';

import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { ensureNativeRenderProject, resolveNativeRenderSource } from '../../../platform/renderService';

const IDLE = Object.freeze({ projectId: null, sourceAsset: null, bindingError: null });

/**
 * The project and source asset one preview surface's requests belong to, or nulls while unresolved.
 *
 * The whole asset record rather than its identifier alone, because the render request every frame
 * carries is built by `buildNativeRenderRequest`, which validates the source it names. Handing the
 * identifier on and rebuilding the record around it would be a second description of the same asset.
 */
export const useNativePreviewBinding = (source) => {
  const [binding, setBinding] = useState(IDLE);

  useEffect(() => {
    if (source === null || source === undefined || !isDesktopRuntime()) {
      setBinding(IDLE);
      return undefined;
    }
    let superseded = false;
    (async () => {
      try {
        const asset = await resolveNativeRenderSource(source);
        const projectId = await ensureNativeRenderProject(asset);
        if (!superseded) setBinding({ projectId, sourceAsset: asset, bindingError: null });
      } catch (error) {
        // A selected native source that cannot bind is a real refusal, not dormancy. Keeping this
        // error typed lets the UI report it outside the picture instead of silently showing raw video.
        if (!superseded) {
          setBinding({
            projectId: null,
            sourceAsset: null,
            bindingError: {
              code: error?.code ?? 'previewProjectBindingFailed',
              nativeCode: error?.nativeCode ?? null,
            },
          });
        }
      }
    })();
    return () => {
      superseded = true;
    };
  }, [source]);

  return binding;
};

/**
 * The decoded size of the source in a `<video>` element, or `null` until it has metadata.
 *
 * `resetKey` re-reads the element when the source changes. An element that is loading a new file
 * reports a zero size, which becomes `null` here, so the surface goes dormant for the moment between
 * two sources rather than composing the new file at the previous file's aspect ratio.
 */
export const useVideoSourceDimensions = (videoRef, resetKey = null) => {
  const [dimensions, setDimensions] = useState(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return undefined;
    const read = () => {
      const widthPx = element.videoWidth;
      const heightPx = element.videoHeight;
      setDimensions(
        Number.isInteger(widthPx) && Number.isInteger(heightPx) && widthPx > 0 && heightPx > 0
          ? { widthPx, heightPx }
          : null,
      );
    };
    read();
    element.addEventListener('loadedmetadata', read);
    element.addEventListener('resize', read);
    return () => {
      element.removeEventListener('loadedmetadata', read);
      element.removeEventListener('resize', read);
    };
  }, [videoRef, resetKey]);

  return dimensions;
};
