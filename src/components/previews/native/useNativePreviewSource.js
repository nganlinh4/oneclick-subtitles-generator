/**
 * The decoded size of a preview surface's source video.
 *
 * The source size is read from the `<video>` element rather than from the media record, because the
 * composition width is derived from the source aspect and the element is the only thing that has
 * actually decoded the file. Until it has, there is no honest composition size and the surface stays
 * dormant instead of guessing 16:9.
 */

import { useEffect, useState } from 'react';

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
