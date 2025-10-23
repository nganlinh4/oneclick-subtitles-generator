/**
 * Handles the dragging functionality for settings tabs
 * This allows users to scroll horizontally through tabs by dragging
 */

/**
 * Initialize the drag functionality for the settings tabs
 * @param {string} tabsSelector - CSS selector for the settings tabs container
 */
export const initSettingsTabsDrag = (tabsSelector = '.settings-tabs') => {
  // FIX: Import both the main initializer and the specific update function
  const { default: initSettingsTabPillAnimation, positionPillForActiveTab } = require('./settingsTabPillAnimation');
  
  const tabContainers = document.querySelectorAll(tabsSelector);
  if (!tabContainers.length) return;

  tabContainers.forEach(tabContainer => {
    // FIX: Run the full initialization only ONCE per container
    initSettingsTabPillAnimation(tabsSelector);
    
    let isDragging = false;
    let startX = 0;
    let startScrollLeft = 0;
    let scrollDebounceTimer = null;

    const checkOverflow = () => {
      if (tabContainer.scrollWidth > tabContainer.clientWidth) {
        tabContainer.classList.add('has-overflow');
      } else {
        tabContainer.classList.remove('has-overflow');
      }
    };
    checkOverflow();
    window.addEventListener('resize', checkOverflow);

    // FIX: This update function is now lightweight. It calls the exported
    // `positionPillForActiveTab` directly instead of re-initializing everything.
    const updatePillPosition = () => {
      positionPillForActiveTab(tabContainer);
    };

    const handleMouseDown = (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      tabContainer.classList.add('dragging');
      startX = e.pageX;
      startScrollLeft = tabContainer.scrollLeft;
      e.preventDefault();
    };

    const handleTouchStart = (e) => {
      isDragging = true;
      tabContainer.classList.add('dragging');
      startX = e.touches[0].pageX;
      startScrollLeft = tabContainer.scrollLeft;
    };

    const handleMove = (x) => {
      if (!isDragging) return;
      const deltaX = x - startX;
      // No requestAnimationFrame needed here; direct manipulation is more responsive for dragging
      tabContainer.scrollLeft = startScrollLeft - deltaX;
    };

    const handleMouseMove = (e) => handleMove(e.pageX);
    const handleTouchMove = (e) => {
      handleMove(e.touches[0].pageX);
      // Only prevent default if we're actually dragging tabs (not just scrolling the page)
      if (isDragging) {
        e.preventDefault(); // Prevent page scroll while dragging tabs
      }
    };

    const handleRelease = () => {
      isDragging = false;
      tabContainer.classList.remove('dragging');
    };

    // Use a debounced call on scroll to avoid excessive updates
    const handleScroll = () => {
      clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = setTimeout(updatePillPosition, 50); // Debounce for 50ms
    };

    tabContainer.addEventListener('mousedown', handleMouseDown);
    tabContainer.addEventListener('touchstart', handleTouchStart, { passive: true }); // passive: true is fine for start
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('mouseup', handleRelease);
    window.addEventListener('touchend', handleRelease);
    tabContainer.addEventListener('scroll', handleScroll, { passive: true });

    tabContainer._cleanupDrag = () => {
      window.removeEventListener('resize', checkOverflow);
      tabContainer.removeEventListener('mousedown', handleMouseDown);
      tabContainer.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('mouseup', handleRelease);
      window.removeEventListener('touchend', handleRelease);
      tabContainer.removeEventListener('scroll', handleScroll);
    };
  });

  return () => {
    document.querySelectorAll(tabsSelector).forEach(tabContainer => {
      if (tabContainer._cleanupDrag) {
        tabContainer._cleanupDrag();
        delete tabContainer._cleanupDrag;
      }
    });
  };
};

export default initSettingsTabsDrag;