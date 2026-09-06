import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Traps keyboard focus within container while active, restores focus on unmount,
 * and intercepts Escape to call onEscape.
 *
 * @param {import('react').RefObject<HTMLElement>} containerRef
 * @param {boolean} isActive
 * @param {(() => void)|null} onEscape
 */
export const useFocusTrap = (containerRef, isActive = true, onEscape = null) => {
  const previousActiveElementRef = useRef(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!isActive) return;

    if (typeof document !== 'undefined') {
      previousActiveElementRef.current = document.activeElement;
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (typeof onEscapeRef.current === 'function') {
          e.preventDefault();
          e.stopPropagation();
          onEscapeRef.current();
        }
        return;
      }

      if (e.key !== 'Tab') return;

      const container = containerRef.current;
      if (!container) return;

      const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null && !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1'
      );

      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstElement || !container.contains(document.activeElement)) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement || !container.contains(document.activeElement)) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (container) {
        const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
          (el) => el.offsetParent !== null && !el.hasAttribute('disabled')
        );
        if (focusable.length > 0) {
          focusable[0].focus();
        }
      }
    }, 50);

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === 'function') {
        try {
          previousActiveElementRef.current.focus();
        } catch {
          // Best effort
        }
      }
    };
  }, [isActive, containerRef]);
};

export default useFocusTrap;
