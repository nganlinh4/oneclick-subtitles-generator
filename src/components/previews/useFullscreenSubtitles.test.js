import { act, renderHook } from '@testing-library/react';
import useFullscreenSubtitles from './useFullscreenSubtitles';

let fullscreenElement = null;

const buildPreview = () => {
  const container = document.createElement('div');
  container.className = 'native-video-container';
  const wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper';
  const video = document.createElement('video');
  wrapper.appendChild(video);
  container.appendChild(wrapper);
  document.body.appendChild(container);
  return { container, wrapper, video };
};

const renderFullscreen = () => {
  const preview = buildPreview();
  const setters = {
    setControlsVisible: vi.fn(),
    setShowCustomControls: vi.fn(),
    setIsVideoHovered: vi.fn(),
  };
  const view = renderHook(() => useFullscreenSubtitles({
    videoRef: { current: preview.video },
    videoContainerRef: { current: preview.container },
    ...setters,
  }));
  return { ...view, ...preview, ...setters };
};

const changeFullscreen = (element) => {
  fullscreenElement = element;
  act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
};

beforeEach(() => {
  vi.useFakeTimers();
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete document.fullscreenElement;
  delete document.exitFullscreen;
  document.body.innerHTML = '';
});

test('entering fullscreen on the preview container shows controls and fills the screen', () => {
  const view = renderFullscreen();

  changeFullscreen(view.container);
  expect(view.result.current.isFullscreen).toBe(true);
  expect(view.setControlsVisible).toHaveBeenLastCalledWith(true);
  expect(view.setShowCustomControls).toHaveBeenLastCalledWith(true);
  expect(view.video.classList.contains('fullscreen-video')).toBe(true);

  act(() => { vi.advanceTimersByTime(100); });
  expect(view.video.style.getPropertyValue('width')).toBe('100vw');
  expect(view.video.style.getPropertyPriority('width')).toBe('important');
  expect(view.wrapper.style.getPropertyValue('position')).toBe('fixed');
  expect(view.container.style.getPropertyValue('z-index')).toBe('998');
});

test('another element going fullscreen does not count as the preview', () => {
  const view = renderFullscreen();
  const other = document.createElement('div');

  changeFullscreen(other);

  expect(view.result.current.isFullscreen).toBe(false);
  expect(view.setShowCustomControls).not.toHaveBeenCalled();
});

test('leaving fullscreen restores the inline styles and hover state', () => {
  const view = renderFullscreen();
  changeFullscreen(view.container);
  act(() => { vi.advanceTimersByTime(100); });

  changeFullscreen(null);
  act(() => { vi.advanceTimersByTime(100); });

  expect(view.result.current.isFullscreen).toBe(false);
  expect(view.video.classList.contains('fullscreen-video')).toBe(false);
  expect(view.video.style.getPropertyValue('width')).toBe('');
  expect(view.wrapper.style.getPropertyValue('position')).toBe('');
  expect(view.container.style.getPropertyValue('width')).toBe('');
  expect(view.container.style.cursor).toBe('default');
  expect(view.setControlsVisible).toHaveBeenLastCalledWith(false);
  expect(view.setIsVideoHovered).toHaveBeenLastCalledWith(false);
});

test('the exit button asks the document to leave fullscreen and then resets state', () => {
  document.exitFullscreen = vi.fn(() => {
    fullscreenElement = null;
    return Promise.resolve();
  });
  const view = renderFullscreen();
  changeFullscreen(view.container);
  view.setControlsVisible.mockClear();

  act(() => view.result.current.handleFullscreenExit());
  expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
  act(() => { vi.advanceTimersByTime(100); });

  expect(view.result.current.isFullscreen).toBe(false);
  expect(view.setControlsVisible).toHaveBeenCalledWith(false);
});

test('a resize after a missed exit event resynchronises the state', () => {
  const view = renderFullscreen();
  changeFullscreen(view.container);

  fullscreenElement = null;
  act(() => { window.dispatchEvent(new Event('resize')); });

  expect(view.result.current.isFullscreen).toBe(false);
});

test('unmount removes the document listeners', () => {
  const view = renderFullscreen();
  view.unmount();

  changeFullscreen(view.container);
  expect(view.setShowCustomControls).not.toHaveBeenCalled();
});
