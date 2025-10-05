/**
 * Functional custom scrollbar for reference text areas
 * Creates a real scrollbar that shows position and allows dragging
 */

// Inject CSS once to hide native scrollbars where we use functional scrollbars (narration section)
function ensureHideNativeScrollbarCSS() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('hide-native-scrollbar-style')) return;
  const style = document.createElement('style');
  style.id = 'hide-native-scrollbar-style';
  style.textContent = `
    .hide-native-scrollbar {
      -ms-overflow-style: none; /* IE and Edge */
      scrollbar-width: none; /* Firefox */
    }
    .hide-native-scrollbar::-webkit-scrollbar {
      width: 0;
      height: 0;
      display: none; /* Safari and Chrome */
    }
  `;
  document.head.appendChild(style);
}

class FunctionalScrollbar {
  constructor(container, textarea) {
    this.container = container;
    this.textarea = textarea;
    this.thumb = null;
    this.isDragging = false;
    this.dragStartY = 0;
    this.dragStartScrollTop = 0;
    this.isLyricContent = container.classList.contains('lyric-content');
    this.fixedRightPosition = null; // Cache the right position for lyric content

    this.init();
  }

  init() {
    // Ensure the container is positioned for absolute thumb placement
    try {
      const style = window.getComputedStyle(this.container);
      if (style.position === 'static') {
        this.container.style.position = 'relative';
      }
    } catch {}

    // Create thumb element
    this.thumb = document.createElement('div');
    this.thumb.className = 'custom-scrollbar-thumb';
    this.container.appendChild(this.thumb);

    // Bind event handlers
    this.handleScroll = this.handleScroll.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.handleThumbClick = this.handleThumbClick.bind(this);

    // Add event listeners
    this.textarea.addEventListener('scroll', this.handleScroll);
    this.thumb.addEventListener('mousedown', this.handleMouseDown);
    this.container.addEventListener('click', this.handleThumbClick);

    // Initial update
    this.updateThumbPosition();

    // Update on content changes
    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateThumbPosition();
      });
      this.resizeObserver.observe(this.textarea);
    }
  }

  updateScrollbar() {
    this.updateThumbPosition();
  }

  handleScroll() {
    if (!this.isDragging) {
      this.updateThumbPosition();
    }
  }

  handleMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();

    this.isDragging = true;
    this.dragStartY = e.clientY;
    this.dragStartScrollTop = this.textarea.scrollTop;

    // Add global mouse event listeners
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mouseup', this.handleMouseUp);

    // Add dragging class for visual feedback
    this.thumb.classList.add('dragging');
    document.body.style.userSelect = 'none';
  }

  handleMouseMove(e) {
    if (!this.isDragging) return;

    e.preventDefault();

    const deltaY = e.clientY - this.dragStartY;
    const { scrollHeight, clientHeight } = this.textarea;
    const maxScrollTop = scrollHeight - clientHeight;

    // Use appropriate height for drag calculations
    let dragHeight;
    if (this.isLyricContent) {
      dragHeight = clientHeight; // Use textarea height for lyric content
    } else {
      dragHeight = this.container.clientHeight - 16; // Use container height for others
    }

    // Calculate scroll position based on thumb movement
    const scrollRatio = dragHeight > 0 ? deltaY / dragHeight : 0;
    const newScrollTop = this.dragStartScrollTop + (scrollRatio * maxScrollTop);

    // Clamp scroll position
    const clampedScrollTop = Math.max(0, Math.min(newScrollTop, maxScrollTop));
    this.textarea.scrollTop = clampedScrollTop;

    // ALWAYS delegate the visual update to the main function for consistency.
    // This resolves the "flying" issue by using a single source of truth for positioning.
    this.updateThumbPosition(clampedScrollTop);
  }

  updateThumbPosition(scrollTop = null) {
    const { scrollHeight, clientHeight } = this.textarea;
    const currentScrollTop = scrollTop !== null ? scrollTop : this.textarea.scrollTop;

    // Check if content overflows
    const hasScrollableContent = scrollHeight > clientHeight;

    // Update container class for track visibility
    if (hasScrollableContent) {
      this.container.classList.add('has-scrollable-content');
    } else {
      this.container.classList.remove('has-scrollable-content');
    }

    // Hide scrollbar if content doesn't overflow
    if (!hasScrollableContent) {
      this.thumb.style.opacity = '0';
      this.thumb.style.pointerEvents = 'none';
      return;
    }

    // For lyric items, position scrollbar relative to the lyric-text element
    if (this.isLyricContent) {
      // --- THIS IS THE FIX ---
      // We no longer calculate `right`. CSS will handle it.
      // We ONLY calculate `top` and `height`.

      const containerRect = this.container.getBoundingClientRect();
      const textareaRect = this.textarea.getBoundingClientRect();
      const textareaTop = textareaRect.top - containerRect.top;
      const thumbHeight = Math.max((clientHeight / scrollHeight) * clientHeight, 20);
      const maxScrollTop = scrollHeight - clientHeight;
      const scrollPercentage = maxScrollTop > 0 ? currentScrollTop / maxScrollTop : 0;
      const maxThumbTop = clientHeight - thumbHeight;
      const thumbTop = textareaTop + (scrollPercentage * maxThumbTop);

      this.thumb.style.height = `${thumbHeight}px`;
      this.thumb.style.top = `${thumbTop}px`;

    } else {
      // Default positioning for other elements (this logic was already fine)
      const containerHeight = this.container.clientHeight - 16; // Account for padding
      const thumbHeight = Math.max((clientHeight / scrollHeight) * containerHeight, 20);
      const maxScrollTop = scrollHeight - clientHeight;
      const scrollPercentage = maxScrollTop > 0 ? currentScrollTop / maxScrollTop : 0;
      const maxThumbTop = containerHeight - thumbHeight;
      const thumbTop = scrollPercentage * maxThumbTop + 8; // Add top padding

      this.thumb.style.height = `${thumbHeight}px`;
      this.thumb.style.top = `${thumbTop}px`;
    }

    this.thumb.style.pointerEvents = 'auto';
    // Always show scrollbar when content is scrollable (no hover requirement)
    this.thumb.style.opacity = '1';
  }

  handleMouseUp() {
    if (!this.isDragging) return;

    this.isDragging = false;

    // Remove global mouse event listeners
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);

    // Remove dragging class
    this.thumb.classList.remove('dragging');
    document.body.style.userSelect = '';

    this.updateThumbPosition();
  }

  handleThumbClick(e) {
    // Only handle clicks on the track area (right side), ignore normal clicks on content
    if (e.target === this.thumb) return;

    const rect = this.container.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top - 8; // Account for padding

    // Define a 12px wide track area from the right edge
    const trackZoneStart = rect.width - 12;
    if (clickX < trackZoneStart) {
      return; // Don't interfere with regular content clicks
    }

    const containerHeight = this.container.clientHeight - 16;
    const { scrollHeight, clientHeight } = this.textarea;
    const maxScrollTop = scrollHeight - clientHeight;

    // Calculate target scroll position
    const scrollPercentage = Math.max(0, Math.min(1, clickY / containerHeight));
    const targetScrollTop = scrollPercentage * maxScrollTop;

    // Jump instantly to target position (no smooth behavior)
    this.textarea.scrollTop = targetScrollTop;
  }

  destroy() {
    // Remove event listeners
    this.textarea.removeEventListener('scroll', this.handleScroll);
    this.thumb.removeEventListener('mousedown', this.handleMouseDown);
    this.container.removeEventListener('click', this.handleThumbClick);

    // Clean up global listeners if dragging
    if (this.isDragging) {
      document.removeEventListener('mousemove', this.handleMouseMove);
      document.removeEventListener('mouseup', this.handleMouseUp);
      document.body.style.userSelect = '';
    }

    // Disconnect resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

    // Remove container class
    this.container.classList.remove('has-scrollable-content');

    // Remove thumb element
    if (this.thumb && this.thumb.parentNode) {
      this.thumb.parentNode.removeChild(this.thumb);
    }
  }
}

/**
 * Initialize functional scrollbars for all custom scrollbar containers
 */
export function initializeFunctionalScrollbars() {
  // 1) Lyric items: anchor on lyric-content, scroll element is .lyric-text
  const lyricContents = document.querySelectorAll('.lyric-content:not([data-fs-initialized])');
  lyricContents.forEach((thumbContainer) => {
    const scrollEl = thumbContainer.querySelector('.lyric-text');
    if (!scrollEl) return;
    thumbContainer.setAttribute('data-fs-initialized', 'true');
    thumbContainer._functionalScrollbar = new FunctionalScrollbar(thumbContainer, scrollEl);
  });

  // 2) Generic containers
  const genericContainers = document.querySelectorAll(
    '.reference-text-container:not([data-fs-initialized]), .custom-scrollbar-textarea-container:not([data-fs-initialized])'
  );
  genericContainers.forEach((thumbContainer) => {
    const scrollEl = thumbContainer.querySelector('.reference-text, .custom-scrollbar-textarea');
    if (!scrollEl) return;
    thumbContainer.setAttribute('data-fs-initialized', 'true');
    thumbContainer._functionalScrollbar = new FunctionalScrollbar(thumbContainer, scrollEl);
  });

  // 3) Narration result items: anchor on .result-item, scroll element is .result-text
  const narrationItems = document.querySelectorAll('.result-item:not([data-fs-initialized])');
  narrationItems.forEach((thumbContainer) => {
    const scrollEl = thumbContainer.querySelector('.result-text');
    if (!scrollEl) return;

    // Ensure the CSS to hide native scrollbars exists and apply to narration scroll element
    ensureHideNativeScrollbarCSS();
    scrollEl.classList.add('hide-native-scrollbar');

    thumbContainer.setAttribute('data-fs-initialized', 'true');
    thumbContainer._functionalScrollbar = new FunctionalScrollbar(thumbContainer, scrollEl);
  });
}

/**
 * Clean up all functional scrollbars (based on data attribute)
 */
export function cleanupFunctionalScrollbars() {
  const initializedContainers = document.querySelectorAll('[data-fs-initialized]');
  initializedContainers.forEach((container) => {
    if (container._functionalScrollbar) {
      container._functionalScrollbar.destroy();
      delete container._functionalScrollbar;
    }
    container.removeAttribute('data-fs-initialized');
  });
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeFunctionalScrollbars);
  } else {
    initializeFunctionalScrollbars();
  }

  // Re-initialize when new content is added
  const observer = new MutationObserver((mutations) => {
    let shouldReinit = false;

    mutations.forEach((mutation) => {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains('reference-text-container') ||
                node.classList?.contains('custom-scrollbar-textarea-container') ||
                node.classList?.contains('lyric-content') ||
                node.classList?.contains('result-item') ||
                node.matches?.('.lyric-content .lyric-text, .result-item .result-text') ||
                node.querySelector?.('.reference-text-container, .custom-scrollbar-textarea-container, .lyric-content .lyric-text, .result-item .result-text')) {
              shouldReinit = true;
            }
          }
        });
      }
    });

    if (shouldReinit) {
      setTimeout(initializeFunctionalScrollbars, 100);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}
