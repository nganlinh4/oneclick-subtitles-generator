import { act, renderHook } from '@testing-library/react';

const animationMocks = vi.hoisted(() => ({
  initPill: vi.fn(),
  initDrag: vi.fn(),
  positionPill: vi.fn(),
}));

vi.mock('../../../utils/settingsTabPillAnimation', () => ({
  default: animationMocks.initPill,
  positionPillForActiveTab: animationMocks.positionPill,
}));

vi.mock('../../../utils/settingsTabsDrag', () => ({
  default: animationMocks.initDrag,
}));

import {
  getSettingsTabAnimationDirection,
  scrollActiveSettingsTab,
  settingsTabScrollTarget,
  SETTINGS_TAB_ORDER,
  useSettingsTabPillInit,
  useSettingsTabPillUpdate,
} from './settingsAnimationHelpers';

const createTabs = (activeTab) => {
  const tabs = document.createElement('div');
  for (const tabId of SETTINGS_TAB_ORDER) {
    const button = document.createElement('button');
    button.className = `settings-tab${tabId === activeTab ? ' active' : ''}`;
    button.dataset.settingsTab = tabId;
    button.scrollIntoView = vi.fn();
    tabs.appendChild(button);
  }
  document.body.appendChild(tabs);
  return tabs;
};

const setActiveButton = (tabs, activeTab) => {
  for (const button of tabs.querySelectorAll('.settings-tab')) {
    button.classList.toggle('active', button.dataset.settingsTab === activeTab);
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

it('keeps Tools in the actual Settings order when deriving slide direction', () => {
  expect(SETTINGS_TAB_ORDER).toEqual([
    'api-keys',
    'video-processing',
    'prompts',
    'cache',
    'model-management',
    'tools',
    'about',
  ]);
  expect(getSettingsTabAnimationDirection('model-management', 'tools')).toBe('left');
  expect(getSettingsTabAnimationDirection('tools', 'about')).toBe('left');
  expect(getSettingsTabAnimationDirection('about', 'tools')).toBe('right');
});

it('derives a bounded centre in the tab strip coordinate space', () => {
  expect(settingsTabScrollTarget({
    clientWidth: 300,
    scrollWidth: 900,
    scrollLeft: 100,
    containerLeft: 50,
    activeLeft: 450,
    activeWidth: 100,
  })).toBe(400);

  expect(settingsTabScrollTarget({
    clientWidth: 300,
    scrollWidth: 900,
    scrollLeft: 300,
    containerLeft: 50,
    activeLeft: -250,
    activeWidth: 40,
  })).toBe(0);

  expect(settingsTabScrollTarget({
    clientWidth: 300,
    scrollWidth: 900,
    scrollLeft: 300,
    containerLeft: 50,
    activeLeft: 2_000,
    activeWidth: 40,
  })).toBe(600);
});

it('scrolls only the overflowing tabs strip and cannot move page ancestors', () => {
  const tabs = createTabs('tools');
  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  document.body.insertBefore(modal, tabs);
  modal.appendChild(tabs);
  const active = tabs.querySelector('.settings-tab.active');
  const localScrollTo = vi.fn();
  tabs.scrollTo = localScrollTo;
  Object.defineProperties(tabs, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 900 },
    scrollLeft: { configurable: true, value: 100, writable: true },
  });
  tabs.getBoundingClientRect = () => ({ left: 50, width: 300 });
  active.getBoundingClientRect = () => ({ left: 450, width: 100 });
  document.documentElement.scrollLeft = 17;
  document.body.scrollLeft = 23;
  modal.scrollLeft = 31;

  expect(scrollActiveSettingsTab(tabs, active)).toBe(400);
  expect(localScrollTo).toHaveBeenCalledOnce();
  expect(localScrollTo).toHaveBeenCalledWith({ left: 400, behavior: 'smooth' });
  expect(active.scrollIntoView).not.toHaveBeenCalled();
  expect(document.documentElement.scrollLeft).toBe(17);
  expect(document.body.scrollLeft).toBe(23);
  expect(modal.scrollLeft).toBe(31);
});

it('does nothing when the tabs fit instead of asking any ancestor to scroll', () => {
  const tabs = createTabs('api-keys');
  const active = tabs.querySelector('.settings-tab.active');
  tabs.scrollTo = vi.fn();
  Object.defineProperties(tabs, {
    clientWidth: { configurable: true, value: 700 },
    scrollWidth: { configurable: true, value: 700 },
    scrollLeft: { configurable: true, value: 0, writable: true },
  });
  tabs.getBoundingClientRect = () => ({ left: 100, width: 700 });
  active.getBoundingClientRect = () => ({ left: 140, width: 100 });

  expect(scrollActiveSettingsTab(tabs, active)).toBeNull();
  expect(tabs.scrollTo).not.toHaveBeenCalled();
  expect(active.scrollIntoView).not.toHaveBeenCalled();
});

it('publishes exactly one direction update for each committed tab change', () => {
  const tabs = createTabs('model-management');
  const tabsRef = { current: tabs };
  const setAnimationDirection = vi.fn();
  const { rerender } = renderHook(
    ({ activeTab }) => useSettingsTabPillUpdate({
      tabsRef,
      activeTab,
      setAnimationDirection,
    }),
    { initialProps: { activeTab: 'model-management' } }
  );

  expect(setAnimationDirection).not.toHaveBeenCalled();

  setActiveButton(tabs, 'tools');
  rerender({ activeTab: 'tools' });
  expect(setAnimationDirection).toHaveBeenCalledTimes(1);
  expect(setAnimationDirection).toHaveBeenLastCalledWith('left');

  rerender({ activeTab: 'tools' });
  expect(setAnimationDirection).toHaveBeenCalledTimes(1);

  setActiveButton(tabs, 'about');
  rerender({ activeTab: 'about' });
  expect(setAnimationDirection).toHaveBeenCalledTimes(2);
  expect(setAnimationDirection).toHaveBeenLastCalledWith('left');

  setActiveButton(tabs, 'tools');
  rerender({ activeTab: 'tools' });
  expect(setAnimationDirection).toHaveBeenCalledTimes(3);
  expect(setAnimationDirection).toHaveBeenLastCalledWith('right');
});

it('cancels superseded pill-position timers', () => {
  const tabs = createTabs('api-keys');
  const tabsRef = { current: tabs };
  const setAnimationDirection = vi.fn();
  const { rerender } = renderHook(
    ({ activeTab }) => useSettingsTabPillUpdate({
      tabsRef,
      activeTab,
      setAnimationDirection,
    }),
    { initialProps: { activeTab: 'api-keys' } }
  );

  setActiveButton(tabs, 'prompts');
  rerender({ activeTab: 'prompts' });
  setActiveButton(tabs, 'tools');
  rerender({ activeTab: 'tools' });

  act(() => { vi.advanceTimersByTime(10); });
  expect(animationMocks.positionPill).toHaveBeenCalledTimes(1);
  expect(animationMocks.positionPill).toHaveBeenCalledWith(tabs);
});

it('owns delayed initialization and both initializer cleanups for one mount', () => {
  const tabs = createTabs('api-keys');
  const tabsRef = { current: tabs };
  const cleanupPill = vi.fn();
  const cleanupDrag = vi.fn();
  animationMocks.initPill.mockReturnValue(cleanupPill);
  animationMocks.initDrag.mockReturnValue(cleanupDrag);

  const first = renderHook(() => useSettingsTabPillInit(tabsRef));
  first.unmount();
  act(() => { vi.advanceTimersByTime(50); });
  expect(animationMocks.initPill).not.toHaveBeenCalled();
  expect(animationMocks.initDrag).not.toHaveBeenCalled();

  const second = renderHook(() => useSettingsTabPillInit(tabsRef));
  act(() => { vi.advanceTimersByTime(50); });
  expect(animationMocks.initPill).toHaveBeenCalledTimes(1);
  expect(animationMocks.initDrag).toHaveBeenCalledTimes(1);

  second.unmount();
  expect(cleanupDrag).toHaveBeenCalledTimes(1);
  expect(cleanupPill).toHaveBeenCalledTimes(1);
});
