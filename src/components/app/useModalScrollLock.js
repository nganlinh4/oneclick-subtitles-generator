import { useEffect } from 'react';

export const MODAL_SCROLL_LOCK_ATTRIBUTE = 'data-osg-modal-scroll-lock';

// Modal implementations predate the common app shell and use several backdrop names. Keep the
// compatibility vocabulary in one place: local overlays such as crop/loading are intentionally
// absent because they do not take ownership of the whole page.
export const MODAL_SURFACE_SELECTOR = [
  '.modal-overlay',
  '[class*="-modal-overlay"]',
  '.rules-editor-overlay',
  '.prompt-editor-overlay',
  '.method-selection-overlay',
  '.transcription-method-overlay',
  '.preset-view-modal',
  '.translation-language-input-modal',
  '.onboarding-overlay',
  '.onboarding-reveal-overlay',
].join(', ');

export const syncModalScrollLock = (documentNode = document) => {
  const root = documentNode.documentElement;
  if (!root) return false;
  const locked = documentNode.querySelector(MODAL_SURFACE_SELECTOR) !== null;
  root.toggleAttribute(MODAL_SCROLL_LOCK_ATTRIBUTE, locked);
  return locked;
};

/**
 * One owner for background-page scrolling, including modal portals and nested modals.
 *
 * A MutationObserver is intentional here. Requiring every legacy modal to acquire/release a global
 * counter would make one missed cleanup permanently freeze the application; the rendered DOM is the
 * truth, so closing the final backdrop always releases the lock and opening a nested one keeps it.
 */
export const useModalScrollLock = () => {
  useEffect(() => {
    syncModalScrollLock();
    const observer = new MutationObserver(() => syncModalScrollLock());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.documentElement.removeAttribute(MODAL_SCROLL_LOCK_ATTRIBUTE);
    };
  }, []);
};

