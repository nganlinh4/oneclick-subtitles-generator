import {
  initSettingsTabPillAnimation,
} from './settingsTabPillAnimation';

const resizeObservers = [];

class ResizeObserverDouble {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnect = vi.fn();
    resizeObservers.push(this);
  }

  observe = vi.fn((element) => {
    this.observed.push(element);
  });
}

const rect = ({ left = 0, width = 0 } = {}) => ({
  bottom: 0,
  height: 0,
  left,
  right: left + width,
  top: 0,
  width,
  x: left,
  y: 0,
  toJSON: () => ({}),
});

const createTabs = () => {
  const container = document.createElement('div');
  container.className = 'settings-tabs';

  const precedingTab = document.createElement('button');
  precedingTab.className = 'settings-tab';
  precedingTab.textContent = 'API keys';

  const activeTab = document.createElement('button');
  activeTab.className = 'settings-tab active';
  activeTab.textContent = 'About';

  container.append(precedingTab, activeTab);
  document.body.appendChild(container);
  return { activeTab, container, precedingTab };
};

beforeEach(() => {
  resizeObservers.length = 0;
  vi.stubGlobal('ResizeObserver', ResizeObserverDouble);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([1, 1.2])('remeasures translated or re-fonted tabs in layout pixels at zoom %s', (zoom) => {
  const { activeTab, container, precedingTab } = createTabs();
  let activeGeometry = rect({ left: 120, width: 60 });
  let naturalWidth = 54;

  container.getBoundingClientRect = () => rect({ left: 20 * zoom, width: 300 * zoom });
  activeTab.getBoundingClientRect = () => rect({ left: activeGeometry.left * zoom, width: activeGeometry.width * zoom });
  Object.defineProperty(activeTab, 'offsetLeft', { get: () => activeGeometry.left - 20 });
  Object.defineProperty(activeTab, 'offsetWidth', { get: () => activeGeometry.width });
  Object.defineProperty(container, 'offsetWidth', { get: () => 300 });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function measure() {
    return this.classList.contains('settings-tab') && this.parentElement === document.body ? naturalWidth : 0;
  });
  precedingTab.getBoundingClientRect = () => rect({ left: 30, width: 80 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure() {
    if (this.classList.contains('settings-tab') && this.parentElement === document.body) {
      return rect({ width: naturalWidth });
    }
    return rect();
  });

  const cleanup = initSettingsTabPillAnimation();
  expect(resizeObservers).toHaveLength(1);
  expect(resizeObservers[0].observed).toEqual([container, precedingTab, activeTab]);
  expect(container.style.getPropertyValue('--settings-pill-left')).toBe('100px');
  expect(container.style.getPropertyValue('--settings-pill-width')).toBe('60px');

  // The active key and element do not change. A longer translation on an earlier
  // tab shifts this tab, while the new UI font also changes its natural width.
  activeGeometry = rect({ left: 184, width: 92 });
  naturalWidth = 84;
  resizeObservers[0].callback([{ target: precedingTab }], resizeObservers[0]);

  expect(activeTab.classList).toContain('active');
  expect(container.style.getPropertyValue('--settings-pill-left')).toBe('165px');
  expect(container.style.getPropertyValue('--settings-pill-width')).toBe('90px');

  cleanup();
});

it('keeps a translated active tab visible using only the local tabs strip', () => {
  const { activeTab, container, precedingTab } = createTabs();
  let activeGeometry = rect({ left: 120, width: 60 });
  Object.defineProperties(container, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 800 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  container.scrollTo = vi.fn(({ left }) => { container.scrollLeft = left; });
  container.getBoundingClientRect = () => rect({ left: 20, width: 300 });
  activeTab.getBoundingClientRect = () => activeGeometry;
  precedingTab.getBoundingClientRect = () => rect({ left: 30, width: 80 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure() {
    if (this.classList.contains('settings-tab') && this.parentElement === document.body) {
      return rect({ width: 54 });
    }
    return rect();
  });

  const cleanup = initSettingsTabPillAnimation();
  activeGeometry = rect({ left: 650, width: 80 });
  resizeObservers[0].callback([{ target: precedingTab }], resizeObservers[0]);

  expect(container.scrollTo).toHaveBeenCalledWith({ left: 500, behavior: 'smooth' });
  expect(window.scrollX).toBe(0);
  cleanup();
});

it('disconnects geometry observation and replaces the prior lifecycle on reinitialization', () => {
  createTabs();

  const firstCleanup = initSettingsTabPillAnimation();
  const firstObserver = resizeObservers[0];
  expect(firstObserver.disconnect).not.toHaveBeenCalled();

  const secondCleanup = initSettingsTabPillAnimation();
  const secondObserver = resizeObservers[1];
  expect(firstObserver.disconnect).toHaveBeenCalledOnce();
  expect(secondObserver.disconnect).not.toHaveBeenCalled();

  // The stale cleanup cannot tear down the lifecycle that replaced it.
  firstCleanup();
  expect(secondObserver.disconnect).not.toHaveBeenCalled();

  secondCleanup();
  expect(secondObserver.disconnect).toHaveBeenCalledOnce();
});
