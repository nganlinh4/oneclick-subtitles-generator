import { useEffect } from 'react';

// NOTE: this file lives in src/components/settings/utils/, one level deeper than
// SettingsModal.js (src/components/settings/), so '../../utils/X' from the modal
// becomes '../../../utils/X' here.
import initSettingsTabPillAnimation from '../../../utils/settingsTabPillAnimation';
import initSettingsTabsDrag from '../../../utils/settingsTabsDrag';

// Tab order used to derive slide direction for tab-content transitions
const TAB_ORDER = ['api-keys', 'video-processing', 'prompts', 'cache', 'model-management', 'about'];

/**
 * Initialize the tab pill animation and drag-to-scroll behavior on mount.
 * @param {React.RefObject} tabsRef - ref to the tabs container element
 */
export const useSettingsTabPillInit = (tabsRef) => {
  // Initialize pill position and drag functionality on component mount
  useEffect(() => {
    if (tabsRef.current) {
      // Small delay to ensure the DOM is fully rendered
      setTimeout(() => {
        initSettingsTabPillAnimation('.settings-tabs');

        // Initialize drag functionality for tabs
        const cleanupDrag = initSettingsTabsDrag('.settings-tabs');

        // Return cleanup function
        return () => {
          if (cleanupDrag) cleanupDrag();
        };
      }, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};

/**
 * Update pill position and animation direction when the active tab changes.
 * @param {Object} params
 * @param {React.RefObject} params.tabsRef - ref to the tabs container element
 * @param {string} params.activeTab - current active tab key
 * @param {string|null} params.previousTab - previously active tab key
 * @param {Function} params.setAnimationDirection - setter for slide direction
 * @param {Function} params.setPreviousTab - setter for previous tab
 */
export const useSettingsTabPillUpdate = ({
  tabsRef,
  activeTab,
  previousTab,
  setAnimationDirection,
  setPreviousTab,
}) => {
  // Update pill position when active tab changes
  useEffect(() => {
    if (tabsRef.current) {
      // Reset wasActive and lastActive attributes on all tabs when active tab changes programmatically
      const tabButtons = tabsRef.current.querySelectorAll('.settings-tab');
      tabButtons.forEach(tab => {
        tab.dataset.wasActive = 'false';
        tab.dataset.lastActive = 'false';
      });

      // Determine animation direction based on tab order
      if (previousTab) {
        const prevIndex = TAB_ORDER.indexOf(previousTab);
        const currentIndex = TAB_ORDER.indexOf(activeTab);

        if (prevIndex !== -1 && currentIndex !== -1) {
          if (prevIndex < currentIndex) {
            setAnimationDirection('left');
          } else if (prevIndex > currentIndex) {
            setAnimationDirection('right');
          } else {
            setAnimationDirection('center');
          }
        } else {
          setAnimationDirection('center');
        }
      }

      // Update previous tab for next change
      setPreviousTab(activeTab);

      // Small delay to ensure the active class is applied
      setTimeout(() => {
        initSettingsTabPillAnimation('.settings-tabs');
        const activeButton = tabsRef.current?.querySelector('.settings-tab.active');
        activeButton?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'center',
        });
      }, 10);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, previousTab]);
};
