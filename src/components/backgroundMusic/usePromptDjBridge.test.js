import { renderHook } from '@testing-library/react';
import usePromptDjBridge from './usePromptDjBridge';

const ORIGIN = 'http://127.0.0.1:3030';

const send = (data, { source = window, origin = ORIGIN } = {}) => {
  window.dispatchEvent(new MessageEvent('message', { data, source, origin }));
};

const handlerSet = () => ({
  onNativeStart: vi.fn(),
  onNativeUpdate: vi.fn(),
  onNativeControl: vi.fn(),
  onNativeClose: vi.fn(),
  onRecordingStarted: vi.fn(),
  onRecordingStopped: vi.fn(),
  onRecordingError: vi.fn(),
  onMidiInputs: vi.fn(),
});

const getPromptDjWindow = () => window;

afterEach(() => {
  vi.restoreAllMocks();
  delete window.recordToastHistory;
});

test('routes each PromptDJ message to its handler', () => {
  const handlers = handlerSet();
  renderHook(() => usePromptDjBridge({ getPromptDjWindow, promptDjOrigin: ORIGIN, handlers }));
  const blob = new Blob(['x'], { type: 'audio/wav' });

  send({ type: 'pm-dj-native-start', weightedPrompts: [{ text: 'a', weight: 1 }] });
  send({ type: 'pm-dj-native-update', weightedPrompts: [] });
  send({ type: 'pm-dj-native-control', control: 'pause' });
  send({ type: 'pm-dj-native-close' });
  send({ type: 'pm-dj-recording-started' });
  send({ type: 'pm-dj-recording-stopped', blob });
  send({ type: 'pm-dj-recording-error' });

  expect(handlers.onNativeStart).toHaveBeenCalledWith([{ text: 'a', weight: 1 }]);
  expect(handlers.onNativeUpdate).toHaveBeenCalledWith([]);
  expect(handlers.onNativeControl).toHaveBeenCalledWith('pause');
  expect(handlers.onNativeClose).toHaveBeenCalledTimes(1);
  expect(handlers.onRecordingStarted).toHaveBeenCalledTimes(1);
  expect(handlers.onRecordingStopped).toHaveBeenCalledWith(blob);
  expect(handlers.onRecordingError).toHaveBeenCalledTimes(1);
});

test('ignores messages from another source or origin and malformed payloads', () => {
  const handlers = handlerSet();
  renderHook(() => usePromptDjBridge({ getPromptDjWindow, promptDjOrigin: ORIGIN, handlers }));

  send({ type: 'pm-dj-native-close' }, { origin: 'https://evil.test' });
  send({ type: 'pm-dj-native-close' }, { source: null });
  send('pm-dj-native-close');
  send({ type: 7 });

  expect(handlers.onNativeClose).not.toHaveBeenCalled();
});

test('sanitizes MIDI inputs and optional state', () => {
  const handlers = handlerSet();
  renderHook(() => usePromptDjBridge({ getPromptDjWindow, promptDjOrigin: ORIGIN, handlers }));

  send({
    type: 'midi:inputs',
    inputs: [{ id: 'a', name: 'Keys', extra: true }, { id: 3, name: 'bad' }, null],
    activeId: 'x'.repeat(513),
    show: true,
  });

  expect(handlers.onMidiInputs).toHaveBeenCalledWith({
    inputs: [{ id: 'a', name: 'Keys' }],
    activeId: undefined,
    show: true,
  });
});

test('records only bounded toast history with a known type', () => {
  window.recordToastHistory = vi.fn();
  renderHook(() => usePromptDjBridge({ getPromptDjWindow, promptDjOrigin: ORIGIN, handlers: {} }));

  send({ type: 'pm-dj-toast-history', message: 'hello', toastType: 'info' });
  send({ type: 'pm-dj-toast-history', message: 'hello', toastType: 'shout' });
  send({ type: 'pm-dj-toast-history', message: '', toastType: 'info' });

  expect(window.recordToastHistory).toHaveBeenCalledExactlyOnceWith('hello', 'info');
});

test('new handlers are used without re-subscribing the window listener', () => {
  const addListener = vi.spyOn(window, 'addEventListener');
  const first = handlerSet();
  const { rerender } = renderHook(
    ({ handlers }) => usePromptDjBridge({ getPromptDjWindow, promptDjOrigin: ORIGIN, handlers }),
    { initialProps: { handlers: first } },
  );
  const second = handlerSet();
  rerender({ handlers: second });

  send({ type: 'pm-dj-recording-error' });

  expect(addListener.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1);
  expect(first.onRecordingError).not.toHaveBeenCalled();
  expect(second.onRecordingError).toHaveBeenCalledTimes(1);
});
