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
  expect(args.startOperationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(args.onEvent).toBeInstanceOf(MockChannel);
  expect(args.onAudio).toBeInstanceOf(MockChannel);
  expect(args.onEvent).not.toBe(args.onAudio);
  expect(JSON.stringify(args)).not.toMatch(/AIza|apiKey|providerUrl|websocket/i);
});

test('raw PCM remains an ArrayBuffer and malformed chunks terminate with one cleanup', async () => {
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
  await vi.waitFor(() => {
    expect(harness.invokeCommand.mock.calls.filter(([command]) => command === 'live_music_close'))
      .toHaveLength(1);
  });
  expect(onProtocolError).toHaveBeenCalledTimes(1);
  expect(onAudio).toHaveBeenCalledTimes(1);
  expect(harness.service.getActiveSession()).toBeNull();
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
  await harness.service.updatePrompts(harness.id, [{ text: 'jazz', weight: 2 }]);
  await harness.service.applyControl(harness.id, 'resetContext');
  await harness.service.closeSession(harness.id);
  expect(harness.invokeCommand.mock.calls.slice(1).map(([command]) => command)).toEqual([
    'live_music_update',
    'live_music_control',
    'live_music_close',
  ]);
  expect(harness.invokeCommand.mock.calls[3][1]).toEqual({
    startOperationId: args.startOperationId,
  });

  args.onEvent.onmessage({ event: 'closed', sessionId: harness.id });
  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(onProtocolError).not.toHaveBeenCalled();
  expect(harness.service.getActiveSession()).toBeNull();
});

test('mismatched events are terminal, close once, and cannot clear a replacement owner', async () => {
  const firstId = uuidv7();
  const secondId = uuidv7();
  const ids = [firstId, secondId];
  const invokeCommand = vi.fn(async (command) => (
    command === 'live_music_start' ? snapshot(ids.shift()) : undefined
  ));
  const service = createNativeLiveMusicService({
    invokeCommand,
    ChannelConstructor: MockChannel,
    isNativeRuntime: () => true,
  });
  const onReady = vi.fn();
  const onAudio = vi.fn();
  const onProtocolError = vi.fn();
  await service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  }, { onReady, onAudio, onProtocolError });
  const firstChannels = invokeCommand.mock.calls[0][1];

  firstChannels.onEvent.onmessage({ event: 'ready', sessionId: secondId });
  firstChannels.onEvent.onmessage({ event: 'ready', sessionId: firstId });
  firstChannels.onAudio.onmessage(new ArrayBuffer(8));
  await vi.waitFor(() => {
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'live_music_close'))
      .toHaveLength(1);
  });
  expect(invokeCommand.mock.calls.find(([command]) => command === 'live_music_close')[1])
    .toEqual({ startOperationId: firstChannels.startOperationId });
  expect(onProtocolError).toHaveBeenCalledTimes(1);
  expect(onReady).not.toHaveBeenCalled();
  expect(onAudio).not.toHaveBeenCalled();
  expect(service.getActiveSession()).toBeNull();
  await expect(service.updatePrompts(firstId, [{ text: 'late', weight: 1 }]))
    .rejects.toMatchObject({ code: 'invalidLiveMusicRequest' });
  await expect(service.applyControl(firstId, 'play'))
    .rejects.toMatchObject({ code: 'invalidLiveMusicRequest' });
  await expect(service.closeSession(firstId))
    .rejects.toMatchObject({ code: 'invalidLiveMusicRequest' });

  await service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'replacement', weight: 1 }],
  });
  firstChannels.onEvent.onmessage({ event: 'closed', sessionId: firstId });
  expect(service.getActiveSession()).toEqual(snapshot(secondId));
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'live_music_close'))
    .toHaveLength(1);
});

test('protocol cleanup failures are redacted and presentation failures never terminate', async () => {
  const id = uuidv7();
  const privatePath = 'C:\\Users\\person\\live-music.key';
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'live_music_start') return snapshot(id);
    if (command === 'live_music_close') {
      throw { code: 'internal', message: privatePath, cause: { path: privatePath } };
    }
    return undefined;
  });
  const service = createNativeLiveMusicService({
    invokeCommand,
    ChannelConstructor: MockChannel,
    isNativeRuntime: () => true,
  });
  const onProtocolError = vi.fn();
  const onHandlerError = vi.fn(() => { throw new Error('diagnostic callback failed'); });
  const onAudio = vi.fn(() => { throw new Error('player failed'); });
  await service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  }, { onAudio, onProtocolError, onHandlerError });
  const channels = invokeCommand.mock.calls[0][1];

  channels.onAudio.onmessage(new ArrayBuffer(8));
  expect(onAudio).toHaveBeenCalledTimes(1);
  expect(onProtocolError).not.toHaveBeenCalled();
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'live_music_close'))
    .toHaveLength(0);

  channels.onEvent.onmessage({ privatePath });
  channels.onEvent.onmessage({ privatePath: `${privatePath}-late` });
  await vi.waitFor(() => expect(onHandlerError).toHaveBeenCalledTimes(2));
  expect(onProtocolError).toHaveBeenCalledTimes(1);
  const cleanupError = onHandlerError.mock.calls[1][0];
  expect(cleanupError).toMatchObject({
    code: 'internal',
    message: 'The native live music operation could not be completed',
  });
  expect(cleanupError).not.toHaveProperty('cause');
  expect(JSON.stringify(cleanupError)).not.toContain(privatePath);
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'live_music_close'))
    .toHaveLength(1);
});

test('a manual-close and protocol-error race shares one native close', async () => {
  const harness = createHarness();
  let finishClose;
  const closePending = new Promise((resolve) => { finishClose = resolve; });
  harness.invokeCommand.mockImplementation(async (command) => {
    if (command === 'live_music_start') return snapshot(harness.id);
    if (command === 'live_music_close') return closePending;
    return undefined;
  });
  const onProtocolError = vi.fn();
  await harness.service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  }, { onProtocolError });
  const channels = harness.invokeCommand.mock.calls[0][1];

  const closing = harness.service.closeSession(harness.id);
  channels.onAudio.onmessage(new Uint8Array(8));
  channels.onAudio.onmessage(new Uint8Array(8));
  expect(harness.invokeCommand.mock.calls.filter(([command]) => command === 'live_music_close'))
    .toHaveLength(1);
  expect(onProtocolError).toHaveBeenCalledTimes(1);
  expect(harness.service.getActiveSession()).toBeNull();

  finishClose();
  await closing;
  expect(harness.invokeCommand.mock.calls.filter(([command]) => command === 'live_music_close'))
    .toHaveLength(1);
});

test.each([
  ['missing fields', { model: LIVE_MUSIC_MODEL }],
  ['an extra field', { ...snapshot(uuidv7()), privatePath: 'C:\\Users\\person\\session' }],
  ['a wrong valid session id plus malformed metadata', {
    ...snapshot(uuidv7()),
    format: 'hostile-format',
  }],
])('a start snapshot with %s rolls back only its opaque start owner', async (_label, rawSnapshot) => {
  const startOperationId = uuidv7();
  let channels;
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'live_music_start') {
      channels = args;
      return rawSnapshot;
    }
    if (command === 'live_music_rollback_start') return true;
    return undefined;
  });
  const onProtocolError = vi.fn();
  const service = createNativeLiveMusicService({
    invokeCommand,
    ChannelConstructor: MockChannel,
    isNativeRuntime: () => true,
    createOperationId: () => startOperationId,
  });

  await expect(service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  }, { onProtocolError })).rejects.toMatchObject({ code: 'invalidLiveMusicResponse' });
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'live_music_rollback_start'))
    .toEqual([['live_music_rollback_start', { startOperationId }]]);
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'live_music_close'))
    .toHaveLength(0);
  expect(service.getActiveSession()).toBeNull();

  channels.onEvent.onmessage({ privatePath: 'C:\\Users\\person\\late-event' });
  channels.onAudio.onmessage(new Uint8Array(8));
  expect(onProtocolError).not.toHaveBeenCalled();
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'live_music_rollback_start'))
    .toHaveLength(1);
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

test('known command codes survive while native messages and causes are redacted', async () => {
  const privatePath = 'C:\\Users\\person\\live-music.key';
  const service = createNativeLiveMusicService({
    invokeCommand: vi.fn().mockRejectedValue({
      code: 'credentialStoreLocked',
      message: privatePath,
      cause: { path: privatePath },
    }),
    ChannelConstructor: MockChannel,
    isNativeRuntime: () => true,
  });
  const error = await service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  }).catch((failure) => failure);
  expect(error).toMatchObject({
    code: 'credentialStoreLocked',
    message: 'The native live music operation could not be completed',
  });
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(privatePath);
  expect(String(error)).not.toContain(privatePath);
});

test('the Rust internal command code survives with a fixed local message', async () => {
  const service = createNativeLiveMusicService({
    invokeCommand: vi.fn().mockRejectedValue({ code: 'internal', message: 'private details' }),
    ChannelConstructor: MockChannel,
    isNativeRuntime: () => true,
  });
  await expect(service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  })).rejects.toMatchObject({
    code: 'internal',
    message: 'The native live music operation could not be completed',
  });
});

test('session update, control, and close retain only known native command codes', async () => {
  const id = uuidv7();
  const privatePath = 'C:\\Users\\person\\live-music-session';
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'live_music_start') return snapshot(id);
    throw { code: 'invalidInput', message: privatePath, cause: privatePath };
  });
  const service = createNativeLiveMusicService({
    invokeCommand,
    ChannelConstructor: MockChannel,
    isNativeRuntime: () => true,
  });
  await service.startSession({
    credentialId: uuidv7(),
    weightedPrompts: [{ text: 'ambient', weight: 1 }],
  });

  const operations = [
    service.updatePrompts(id, [{ text: 'jazz', weight: 1 }]),
    service.applyControl(id, 'play'),
    service.closeSession(id),
  ];
  for (const operation of operations) {
    const error = await operation.catch((failure) => failure);
    expect(error).toMatchObject({
      code: 'invalidInput',
      message: 'The native live music operation could not be completed',
    });
    expect(JSON.stringify(error)).not.toContain(privatePath);
  }
});

test('unknown command and event codes collapse to fixed local failures', async () => {
  const privatePath = 'C:\\Users\\person\\private.key';
  for (const rejection of [
    { code: 'privateDiagnosticCode', message: privatePath },
    { code: `liveMusicUnavailable${privatePath}`, message: privatePath },
  ]) {
    const service = createNativeLiveMusicService({
      invokeCommand: vi.fn().mockRejectedValue(rejection),
      ChannelConstructor: MockChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.startSession({
      credentialId: uuidv7(),
      weightedPrompts: [{ text: 'ambient', weight: 1 }],
    })).rejects.toMatchObject({
      code: 'liveMusicCommandFailed',
      message: 'The native live music operation could not be completed',
    });
  }

  const known = normalizeLiveMusicEvent({
    event: 'failed',
    sessionId: uuidv7(),
    error: { code: 'liveMusicTimedOut', message: privatePath },
  });
  expect(known.error).toEqual({
    code: 'liveMusicTimedOut',
    message: 'The native live music session timed out.',
  });
  expect(JSON.stringify(known)).not.toContain(privatePath);

  const unknown = normalizeLiveMusicEvent({
    event: 'failed',
    sessionId: uuidv7(),
    error: { code: 'privateDiagnosticCode', message: privatePath },
  });
  expect(unknown.error).toEqual({
    code: 'liveMusicCommandFailed',
    message: 'The native live music operation could not be completed',
  });
  expect(JSON.stringify(unknown)).not.toContain(privatePath);

  for (const code of [null, 42, { privatePath }]) {
    expect(() => normalizeLiveMusicEvent({
      event: 'failed',
      sessionId: uuidv7(),
      error: { code, message: privatePath },
    })).toThrowError(expect.objectContaining({ code: 'invalidLiveMusicResponse' }));
  }
});
