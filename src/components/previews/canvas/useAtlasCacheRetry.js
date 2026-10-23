/**
 * Retry triggers for the canvas preview's atlas cache: an explicit retry token drops every
 * retryable refusal, and a FontFaceSet `loadingdone` drops refusals for faces that were still
 * loading. Both invalidate in-flight bakes and force the next draw to republish.
 */
import { useEffect } from 'react';

const useAtlasCacheRetry = ({
  retryToken,
  retryTokenRef,
  cacheRef,
  pendingRef,
  lifecycleGenerationRef,
  rendererFailureRef,
  publishedRef,
  drawRef,
}) => {
  useEffect(() => {
    if (Object.is(retryTokenRef.current, retryToken)) return;
    retryTokenRef.current = retryToken;
    lifecycleGenerationRef.current += 1;
    pendingRef.current.clear();
    rendererFailureRef.current = null;
    for (const [key, entry] of cacheRef.current) {
      if (entry.retryable === true) cacheRef.current.delete(key);
    }
    publishedRef.current = '';
    drawRef.current();
  }, [retryToken, retryTokenRef, cacheRef, pendingRef, lifecycleGenerationRef, rendererFailureRef, publishedRef, drawRef]);

  useEffect(() => {
    const fonts = document.fonts;
    if (typeof fonts?.addEventListener !== 'function') return undefined;
    const retryActivatedFaces = () => {
      let removed = false;
      for (const [key, entry] of cacheRef.current) {
        if (entry.error === 'glyphAtlasFaceLoading' && entry.retryable === true) {
          cacheRef.current.delete(key);
          removed = true;
        }
      }
      if (!removed) return;
      lifecycleGenerationRef.current += 1;
      pendingRef.current.clear();
      publishedRef.current = '';
      drawRef.current();
    };
    fonts.addEventListener('loadingdone', retryActivatedFaces);
    return () => fonts.removeEventListener('loadingdone', retryActivatedFaces);
  }, [cacheRef, pendingRef, lifecycleGenerationRef, publishedRef, drawRef]);
};

export default useAtlasCacheRetry;
