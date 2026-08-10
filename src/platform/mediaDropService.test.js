import {
  createNativeMediaDropService,
  normalizeNativeMediaDropEvent,
} from './mediaDropService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
}));

const DRAG_ID = '550e8400-e29b-41d4-a716-446655440000';
const OFFER_ID = '9b2c6b54-3a72-44d2-89e8-4979ad45e5f0';
const SUBSCRIPTION_ID = 'a455d8eb-a377-45f8-a724-5b04a795218c';

class TestChannel {
  onmessage = () => {};

  emit(value) {
    this.onmessage(value);
  }
}

const event = (type, extra = {}) => ({
  type,
  dragId: DRAG_ID,
  sequence: 1,
  ...(type === 'leave' ? {} : { position: { x: 250, y: 125 } }),
  ...extra,
});

it('normalizes and freezes every path-free native drop event variant', () => {
  const values = [
    event('enter'),
    event('over'),
    event('leave'),
    event('drop', { offerId: OFFER_ID }),
    event('rejected', { reason: 'multipleFiles' }),
  ];

  for (const value of values) {
    const normalized = normalizeNativeMediaDropEvent(value);
    expect(normalized).toEqual(value);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(JSON.stringify(normalized).toLowerCase()).not.toContain('path');
  }
});

it.each([
  event('drop', { offerId: 'not-an-id' }),
  event('drop', { offerId: OFFER_ID, path: 'C:\\private\\clip.mp4' }),
  event('enter', { position: { x: -1, y: 2 } }),
  event('enter', { position: { x: 1, y: Number.NaN } }),
  event('enter', { sequence: 0 }),
  event('rejected', { reason: 'rawPathRejected' }),
  { ...event('enter'), paths: ['C:\\private\\clip.mp4'] },
  { type: 'unknown', dragId: DRAG_ID, sequence: 1 },
])('rejects hostile or structurally expanded events %#', (value) => {
  expect(() => normalizeNativeMediaDropEvent(value)).toThrow(expect.objectContaining({
    code: 'invalidMediaDropResponse',
  }));
});

it('subscribes with a typed Channel, validates events, and unsubscribes exactly once', async () => {
  let channel;
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'media_drop_subscribe') {
      channel = args.onEvent;
      return { id: SUBSCRIPTION_ID };
    }
    return undefined;
  });
  const onEvent = vi.fn();
  const onProtocolError = vi.fn();
  const service = createNativeMediaDropService({ invokeCommand, ChannelConstructor: TestChannel });

  const subscription = await service.subscribe(onEvent, onProtocolError);
  channel.emit(event('drop', { offerId: OFFER_ID }));
  channel.emit({ ...event('enter'), paths: ['C:\\secret\\clip.mp4'] });

  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ offerId: OFFER_ID }));
  expect(onProtocolError).toHaveBeenCalledWith(expect.objectContaining({
    code: 'invalidMediaDropResponse',
  }));
  await subscription.unsubscribe();
  await subscription.unsubscribe();
  expect(invokeCommand.mock.calls).toEqual([
    ['media_drop_subscribe', { onEvent: channel }],
    ['media_drop_unsubscribe', { subscriptionId: SUBSCRIPTION_ID }],
  ]);
});

it('rejects malformed subscription responses and offer identifiers before IPC', async () => {
  const invokeCommand = vi.fn().mockResolvedValue({ id: '01890f39-7b62-7c4e-8c9a-000000000101' });
  const service = createNativeMediaDropService({ invokeCommand, ChannelConstructor: TestChannel });

  await expect(service.subscribe(() => {})).rejects.toMatchObject({
    code: 'invalidMediaDropResponse',
  });
  await expect(service.discard('not-an-offer')).rejects.toMatchObject({
    code: 'invalidMediaDropRequest',
  });
  expect(invokeCommand).toHaveBeenCalledTimes(1);
});

it('discards only a validated opaque offer identifier', async () => {
  const invokeCommand = vi.fn();
  const service = createNativeMediaDropService({ invokeCommand, ChannelConstructor: TestChannel });

  await service.discard(OFFER_ID);

  expect(invokeCommand).toHaveBeenCalledWith('media_drop_discard', { offerId: OFFER_ID });
});
