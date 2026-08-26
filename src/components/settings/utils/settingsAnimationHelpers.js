import { useEffect, useRef } from 'react';

// NOTE: this file lives in src/components/settings/utils/, one level deeper than
// SettingsModal.js (src/components/settings/), so '../../utils/X' from the modal
// becomes '../../../utils/X' here.
import initSettingsTabPillAnimation, {
  positionPillForActiveTab,
} from '../../../utils/settingsTabPillAnimation';
import initSettingsTabsDrag from '../../../utils/settingsTabsDrag';
import {
  scrollActiveSettingsTab,
  settingsTabScrollTarget,
} from '../../../utils/settingsTabVisibility';

export { scrollActiveSettingsTab, settingsTabScrollTarget };

// Tab order used to derive slide direction for tab-content transitions
export const SETTINGS_TAB_ORDER = Object.freeze([
  'api-keys',
  'video-processing',
  'prompts',
  'cache',
  'model-management',
  'tools',
  'about',
]);

export const getSettingsTabAnimationDirection = (previousTab, activeTab) => {
  const previousIndex = SETTINGS_TAB_ORDER.indexOf(previousTab);
  const activeIndex = SETTINGS_TAB_ORDER.indexOf(activeTab);

  if (previousIndex === -1 || activeIndex === -1 || previousIndex === activeIndex) {
    return 'center';
  }

  return previousIndex < activeIndex ? 'left' : 'right';
};

/**
 * Initialize the tab pill animation and drag-to-scroll behavior on mount.
 * @param {React.RefObject} tabsRef - ref to the tabs container element
 */
export const useSettingsTabPillInit = (tabsRef) => {
  useEffect(() => {
    let cleanupPill;
    let cleanupDrag;
    const initializationTimer = setTimeout(() => {
      if (!tabsRef.current) return;
      cleanupPill = initSettingsTabPillAnimation('.settings-tabs');
      cleanupDrag = initSettingsTabsDrag('.settings-tabs');
    }, 50);

    return () => {
      clearTimeout(initializationTimer);
      cleanupDrag?.();
      cleanupPill?.();
    };
  }, [tabsRef]);
};

/**
 * Update pill position and animation direction when the active tab changes.
 * @param {Object} params
 * @param {React.RefObject} params.tabsRef - ref to the tabs container element
 * @param {string} params.activeTab - current active tab key
 * @param {Function} params.setAnimationDirection - setter for slide direction
 */
export const useSettingsTabPillUpdate = ({
  tabsRef,
  activeTab,
  setAnimationDirection,
}) => {
  const previousTabRef = useRef(activeTab);

  useEffect(() => {
    const previousTab = previousTabRef.current;
    if (previousTab !== activeTab) {
      setAnimationDirection(getSettingsTabAnimationDirection(previousTab, activeTab));
    }
    previousTabRef.current = activeTab;

    const tabs = tabsRef.current;
    if (!tabs) return undefined;

    const tabButtons = tabs.querySelectorAll('.settings-tab');
    tabButtons.forEach(tab => {
      tab.dataset.wasActive = 'false';
      tab.dataset.lastActive = 'false';
    });

    const positionTimer = setTimeout(() => {
      if (tabsRef.current !== tabs) return;
      positionPillForActiveTab(tabs);
      const activeButton = tabs.querySelector('.settings-tab.active');
      scrollActiveSettingsTab(tabs, activeButton);
    }, 10);

    return () => clearTimeout(positionTimer);
  }, [activeTab, setAnimationDirection, tabsRef]);
};
