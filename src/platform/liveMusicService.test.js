import { v7 as uuidv7 } from 'uuid';
import {
  LIVE_MUSIC_CHANNELS,
  LIVE_MUSIC_FORMAT,
  LIVE_MUSIC_MODEL,
  LIVE_MUSIC_SAMPLE_RATE_HZ,
  createNativeLiveMusicService,
  normalizeLiveMusicEvent,
  normalizePcmChunk,
  normalizeWeightedPrompts,
} from './liveMusicService';

vi.mock('@tauri-apps/api/core', () => ({ Channel: class {} }));

class MockChannel {
  constructor() {
    this.onmessage = null;
  }
}

const snapshot = (id) => ({
  id,
  model: LIVE_MUSIC_MODEL,
  sampleRateHz: LIVE_MUSIC_SAMPLE_RATE_HZ,
  channels: LIVE_MUSIC_CHANNELS,
  format: LIVE_MUSIC_FORMAT,
});

const createHarness = () => {
  const id = uuidv7();
  const invokeCommand = vi.fn(async (command, _args) => {
    if (command === 'live_music_start') return snapshot(id);
    return undefined;
  });
  const service = createNativeLiveMusicService({
    invokeCommand,
    ChannelConstructor: MockChannel,
    isNativeRuntime: () => true,
  });
  return { id, invokeCommand, service };
};

test('starts with an opaque credential reference and two distinct Tauri channels', async () => {
  const harness = createHarness();
  const credentialId = uuidv7();
  const result = await harness.service.startSession({
    credentialId,
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  });

  expect(result).toEqual(snapshot(harness.id));
  expect(harness.invokeCommand).toHaveBeenCalledTimes(1);
  const [command, args] = harness.invokeCommand.mock.calls[0];
  expect(command).toBe('live_music_start');
  expect(args.request).toEqual({
    credentialId,
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  });
  expect(args.onEvent).toBeInstanceOf(MockChannel);
  expect(args.onAudio).toBeInstanceOf(MockChannel);
  expect(args.onEvent).not.toBe(args.onAudio);
  expect(JSON.stringify(args)).not.toMatch(/AIza|apiKey|providerUrl|websocket/i);
});

test('raw PCM remains an ArrayBuffer and malformed chunks fail closed', async () => {
  const harness = createHarness();
  const onAudio = vi.fn();
  const onProtocolError = vi.fn();
  await harness.service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  }, { onAudio, onProtocolError });
  const args = harness.invokeCommand.mock.calls[0][1];
  const pcm = new ArrayBuffer(8);
  args.onAudio.onmessage(pcm);
  expect(onAudio).toHaveBeenCalledWith(pcm);

  args.onAudio.onmessage(new Uint8Array(8));
  args.onAudio.onmessage(new ArrayBuffer(3));
  expect(onProtocolError).toHaveBeenCalledTimes(2);
  expect(normalizePcmChunk(new ArrayBuffer(384_000)).byteLength).toBe(384_000);
  expect(() => normalizePcmChunk(new ArrayBuffer(512 * 1024 + 4))).toThrow();
});

test('validates events, session identity, prompts, controls, and terminal lifecycle', async () => {
  const harness = createHarness();
  const onReady = vi.fn();
  const onClosed = vi.fn();
  const onProtocolError = vi.fn();
  await harness.service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  }, { onReady, onClosed, onProtocolError });
  const args = harness.invokeCommand.mock.calls[0][1];

  args.onEvent.onmessage({ event: 'ready', sessionId: harness.id });
  expect(onReady).toHaveBeenCalledTimes(1);
  args.onEvent.onmessage({ event: 'ready', sessionId: uuidv7() });
  expect(onProtocolError).toHaveBeenCalledTimes(1);

  await harness.service.updatePrompts(harness.id, [{ text: 'jazz', weight: 2 }]);
  await harness.service.applyControl(harness.id, 'resetContext');
  await harness.service.closeSession(harness.id);
  expect(harness.invokeCommand.mock.calls.slice(1).map(([command]) => command)).toEqual([
    'live_music_update',
    'live_music_control',
    'live_music_close',
  ]);

  args.onEvent.onmessage({ event: 'closed', sessionId: harness.id });
  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(harness.service.getActiveSession()).toBeNull();
});

test('hostile objects and content bounds cannot cross the bridge', () => {
  expect(() => normalizeWeightedPrompts([])).toThrow();
  expect(() => normalizeWeightedPrompts([{ text: 'x', weight: 0 }])).toThrow();
  expect(() => normalizeWeightedPrompts([{ text: 'x', weight: 1, secret: 'no' }])).toThrow();
  expect(() => normalizeLiveMusicEvent({
    event: 'filteredPrompt',
    sessionId: uuidv7(),
    text: 'x',
    reason: 'y',
    extra: 'ignored',
  })).toThrow();
  expect(() => normalizeLiveMusicEvent({
    event: 'warning',
    sessionId: uuidv7(),
    message: 'x'.repeat(2_049),
  })).toThrow();
});

test('native failures are fixed and never retain a hostile transport cause', async () => {
  const secretBearingError = new Error('AIza-never-retained');
  const service = createNativeLiveMusicService({
    invokeCommand: vi.fn().mockRejectedValue(secretBearingError),
    ChannelConstructor: MockChannel,
    isNativeRuntime: () => true,
  });
  const error = await service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  }).catch((failure) => failure);
  expect(error.code).toBe('liveMusicCommandFailed');
  expect(error.message).not.toContain('AIza');
  expect(error.cause).toBeUndefined();
});
