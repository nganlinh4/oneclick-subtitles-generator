/**
 * Drag-to-resize height for the PromptDJ panel. The height is a device preference; while a drag
 * is active `isResizing` lets the caller cover the iframe so it cannot swallow pointer events.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { readPreference, writePreference } from '../../platform/preferences/store';

const DEFAULT_HEIGHT = 600;
const MIN_HEIGHT = 280;
const MAX_HEIGHT = 1400;

const pointerClientY = (e) => (
  e.clientY ?? (e.touches && e.touches[0] && e.touches[0].clientY) ?? 0
);

const useResizablePanelHeight = () => {
  const [panelHeight, setPanelHeight] = useState(() => readPreference('bg_music_panel_height'));
  const [isResizing, setIsResizing] = useState(false);

  const panelRef = useRef(null);
  const resizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Keep latest height in a ref to avoid stale closures
  const latestHeightRef = useRef(panelHeight);
  useEffect(() => { latestHeightRef.current = panelHeight; }, [panelHeight]);

  const onAnyMove = useCallback((e) => {
    if (!resizingRef.current) return;
    const dy = pointerClientY(e) - startYRef.current;
    let next = startHeightRef.current + dy;
    next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, next));
    setPanelHeight(next);
  }, []);

  const onAnyTouchMove = useCallback((e) => onAnyMove(e), [onAnyMove]);

  const endResize = useCallback(() => {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    try { document.body.style.cursor = ''; document.body.style.userSelect = ''; } catch {
      // The panel can unmount while a resize gesture is ending.
    }
    const finalH = Math.round(panelRef.current?.offsetHeight || latestHeightRef.current || DEFAULT_HEIGHT);
    writePreference('bg_music_panel_height', finalH);
    // Remove all possible listeners
    window.removeEventListener('pointermove', onAnyMove);
    window.removeEventListener('pointerup', endResize);
    window.removeEventListener('pointercancel', endResize);
    window.removeEventListener('mousemove', onAnyMove);
    window.removeEventListener('mouseup', endResize);
    window.removeEventListener('touchmove', onAnyTouchMove);
    window.removeEventListener('touchend', endResize);
    window.removeEventListener('touchcancel', endResize);
    window.removeEventListener('blur', endResize);
    setIsResizing(false);
  }, [onAnyMove, onAnyTouchMove]);

  function onResizePointerDown(e) {
    e.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    startYRef.current = pointerClientY(e);
    startHeightRef.current = panelRef.current?.offsetHeight || latestHeightRef.current || panelHeight;
    try { document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; } catch {
      // Detached documents can reject transient style changes.
    }
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {
      // Pointer capture is optional on compatibility WebViews.
    }
    window.addEventListener('pointermove', onAnyMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
    window.addEventListener('mousemove', onAnyMove);
    window.addEventListener('mouseup', endResize);
    window.addEventListener('touchmove', onAnyTouchMove, { passive: false });
    window.addEventListener('touchend', endResize);
    window.addEventListener('touchcancel', endResize);
    window.addEventListener('blur', endResize);
  }

  const resetPanelHeight = () => {
    setPanelHeight(DEFAULT_HEIGHT);
    writePreference('bg_music_panel_height', DEFAULT_HEIGHT);
  };

  return { panelRef, panelHeight, isResizing, onResizePointerDown, resetPanelHeight };
};

export default useResizablePanelHeight;
