import { act, cleanup, render } from '@testing-library/react';
import LyricItem from './LyricItem';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key, fallback) => fallback }) }));
vi.mock('../common/Tooltip.jsx', () => ({ default: ({ children }) => children }));

const props = {
  lyric: { id: 'continuous', start: 0, end: 60, text: 'A continuous cue' },
  index: 0, isCurrentLyric: true, currentTime: 1, allowEditing: false,
  isDragging: () => ({}), getLastDragEnd: () => 0,
};
let frames, video, paused, nextId;
beforeEach(() => {
  frames = new Map(); nextId = 0; paused = true;
  vi.stubGlobal('requestAnimationFrame', callback => {
    const id = ++nextId; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
  const preview = document.createElement('div');
  preview.className = 'video-preview';
  video = document.createElement('video'); video.className = 'video-player';
  Object.defineProperty(video, 'paused', { get: () => paused });
  video.currentTime = 1;
  preview.append(video); document.body.append(preview);
});
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const tick = () => act(() => {
  const pending = [...frames.values()]; frames.clear();
  pending.forEach(callback => callback(performance.now()));
});

it('does no animation work while paused, including repeated playhead updates', () => {
  const row = render(<LyricItem {...props} />);
  for (let time = 2; time < 20; time++) {
    video.currentTime = time;
    row.rerender(<LyricItem {...props} currentTime={time} />);
    expect(frames.size).toBe(0);
  }
  expect(row.container.querySelector('.progress-indicator').style.transform).toBe(`scaleX(${19 / 60})`);
});

it('owns exactly one loop while playing and releases it on pause and unmount', () => {
  paused = false;
  const row = render(<LyricItem {...props} />);
  for (let time = 2; time < 20; time++) {
    video.currentTime = time;
    row.rerender(<LyricItem {...props} currentTime={time} />);
    tick();
    expect(frames.size).toBe(1);
  }
  paused = true;
  act(() => video.dispatchEvent(new Event('pause')));
  expect(frames.size).toBe(0);
  paused = false;
  act(() => video.dispatchEvent(new Event('play')));
  expect(frames.size).toBe(1);
  row.unmount(); expect(frames.size).toBe(0);
});

it('paints subtitle-only seeks without creating an animation loop', () => {
  video.parentElement.remove();
  const row = render(<LyricItem {...props} currentTime={30} />);
  expect(row.container.querySelector('.progress-indicator').style.transform).toBe('scaleX(0.5)');
  expect(frames.size).toBe(0);
});
