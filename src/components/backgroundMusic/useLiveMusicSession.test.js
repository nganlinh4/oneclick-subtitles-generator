import { act, renderHook } from '@testing-library/react';
import useLiveMusicSession from './useLiveMusicSession';

const mocks = vi.hoisted(() => ({
  credentialId: 'cred-1',
  startLiveMusicSession: vi.fn(),
  closeLiveMusicSession: vi.fn(),
  updateLiveMusicPrompts: vi.fn(),
  applyLiveMusicControl: vi.fn(),
}));

vi.mock('../../platform/credentialStateController', () => ({
  initializeCredentialState: vi.fn(async () => undefined),
  getActiveGeminiCredentialId: () => mocks.credentialId,
}));

vi.mock('../../platform/liveMusicService', () => ({
  startLiveMusicSession: mocks.startLiveMusicSession,
  closeLiveMusicSession: mocks.closeLiveMusicSession,
  updateLiveMusicPrompts: mocks.updateLiveMusicPrompts,
  applyLiveMusicControl: mocks.applyLiveMusicControl,
}));

const failure = (code) => ({
  type: 'pm-dj-native-event',
  payload: { event: 'failed', error: { code, message: expect.any(String) } },
});

const renderSession = () => {
  const postToPromptDj = vi.fn();
  const view = renderHook(() => useLiveMusicSession({ postToPromptDj }));
  return { ...view, postToPromptDj };
};

beforeEach(() => {
  mocks.credentialId = 'cred-1';
  mocks.startLiveMusicSession.mockReset();
  mocks.closeLiveMusicSession.mockReset().mockResolvedValue(undefined);
  mocks.updateLiveMusicPrompts.mockReset().mockResolvedValue(undefined);
  mocks.applyLiveMusicControl.mockReset().mockResolvedValue(undefined);
});

test('starts one session, forwards its events and PCM, then routes updates and controls', async () => {
  let callbacks;
  mocks.startLiveMusicSession.mockImplementation(async (_request, handlers) => {
    callbacks = handlers;
    return { id: 'session-1' };
  });
  const { result, postToPromptDj } = renderSession();
  const prompts = [{ text: 'lofi', weight: 1 }];

  await act(async () => { result.current.onNativeStart(prompts); });
  expect(mocks.startLiveMusicSession).toHaveBeenCalledWith(
    { credentialId: 'cred-1', weightedPrompts: prompts },
    expect.any(Object),
  );

  const pcm = new ArrayBuffer(4);
  callbacks.onEvent({ event: 'started' });
  callbacks.onAudio(pcm);
  expect(postToPromptDj).toHaveBeenCalledWith({ type: 'pm-dj-native-event', payload: { event: 'started' } });
  expect(postToPromptDj).toHaveBeenCalledWith({ type: 'pm-dj-native-audio', pcm }, [pcm]);

  result.current.onNativeUpdate([]);
  result.current.onNativeControl('pause');
  result.current.onNativeControl('explode');
  expect(mocks.updateLiveMusicPrompts).toHaveBeenCalledWith('session-1', []);
  expect(mocks.applyLiveMusicControl).toHaveBeenCalledExactlyOnceWith('session-1', 'pause');

  await act(async () => { result.current.onNativeStart(prompts); });
  expect(mocks.startLiveMusicSession).toHaveBeenCalledTimes(1);
  expect(postToPromptDj).toHaveBeenCalledWith(failure('liveMusicUnavailable'));
});

test('reports a missing credential without starting a session', async () => {
  mocks.credentialId = null;
  const { result, postToPromptDj } = renderSession();

  await act(async () => { result.current.onNativeStart([]); });

  expect(mocks.startLiveMusicSession).not.toHaveBeenCalled();
  expect(postToPromptDj).toHaveBeenCalledWith({ type: 'pm-dj-native-init', available: false });
  expect(postToPromptDj).toHaveBeenCalledWith(failure('liveMusicCredentialUnavailable'));
});

test('a close requested while starting closes the session once it exists', async () => {
  let resolveStart;
  mocks.startLiveMusicSession.mockImplementation(() => new Promise((resolve) => {
    resolveStart = resolve;
  }));
  const { result } = renderSession();

  await act(async () => { result.current.onNativeStart([]); });
  result.current.onNativeClose();
  await act(async () => { resolveStart({ id: 'session-2' }); });

  expect(mocks.closeLiveMusicSession).toHaveBeenCalledExactlyOnceWith('session-2');
});

test('a terminal event drops the session and unmount closes a live one', async () => {
  let callbacks;
  mocks.startLiveMusicSession.mockImplementation(async (_request, handlers) => {
    callbacks = handlers;
    return { id: 'session-3' };
  });
  const first = renderSession();
  await act(async () => { first.result.current.onNativeStart([]); });
  callbacks.onEvent({ event: 'closed' });
  first.result.current.onNativeControl('play');
  expect(mocks.applyLiveMusicControl).not.toHaveBeenCalled();
  first.unmount();
  expect(mocks.closeLiveMusicSession).not.toHaveBeenCalled();

  const second = renderSession();
  await act(async () => { second.result.current.onNativeStart([]); });
  second.unmount();
  expect(mocks.closeLiveMusicSession).toHaveBeenCalledExactlyOnceWith('session-3');
});
