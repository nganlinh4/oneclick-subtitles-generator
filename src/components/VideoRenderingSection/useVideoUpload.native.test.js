import { claimNativeRenderVideo, selectNativeRenderVideo } from './useVideoUpload';

const descriptor = (assetId, type = 'video/mp4', name = 'source.mp4') => Object.freeze({
  __nativeMedia: true,
  assetId,
  playbackId: '550e8400-e29b-41d4-a716-446655440000',
  name,
  type,
  size: 4096,
  lastModified: 0,
  playbackUrl: `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440000?token=${'a'.repeat(64)}`,
});

const PREVIOUS_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const SELECTED_ID = '01890f39-7b62-7c4e-8c9a-000000000102';

test('returns a native video selected specifically for rendering', async () => {
  const selected = descriptor(SELECTED_ID);
  const restore = vi.fn();
  const clear = vi.fn();

  await expect(selectNativeRenderVideo({
    getCurrent: vi.fn(async () => descriptor(PREVIOUS_ID)),
    select: vi.fn(async () => selected),
    restore,
    clear,
  })).resolves.toBe(selected);
  expect(restore).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

test('does not accept a renderer video until exact-project activation finishes', async () => {
  const selected = descriptor(SELECTED_ID);
  let finishActivation;
  const activate = vi.fn(() => new Promise((resolve) => { finishActivation = resolve; }));
  let settled = false;
  const selection = selectNativeRenderVideo({
    getCurrent: vi.fn(async () => descriptor(PREVIOUS_ID)),
    select: vi.fn(async () => selected),
    restore: vi.fn(),
    clear: vi.fn(),
    activate,
  }).then((value) => {
    settled = true;
    return value;
  });

  await vi.waitFor(() => expect(activate).toHaveBeenCalledExactlyOnceWith(selected));
  expect(settled).toBe(false);
  finishActivation();
  await expect(selection).resolves.toBe(selected);
});

test('restores the prior selection when renderer-project activation is refused', async () => {
  const selected = descriptor(SELECTED_ID);
  const restore = vi.fn(async () => descriptor(PREVIOUS_ID));
  const failure = Object.assign(new Error('The subtitle project could not be bound'), {
    code: 'subtitleProjectBindingFailed',
  });

  await expect(selectNativeRenderVideo({
    getCurrent: vi.fn(async () => descriptor(PREVIOUS_ID)),
    select: vi.fn(async () => selected),
    restore,
    clear: vi.fn(),
    activate: vi.fn().mockRejectedValue(failure),
  })).rejects.toBe(failure);
  expect(restore).toHaveBeenCalledExactlyOnceWith(PREVIOUS_ID);
});

test('restores the previous native selection when an audio file is chosen', async () => {
  const restore = vi.fn(async () => descriptor(PREVIOUS_ID));
  const clear = vi.fn();

  await expect(selectNativeRenderVideo({
    getCurrent: vi.fn(async () => descriptor(PREVIOUS_ID)),
    select: vi.fn(async () => descriptor(SELECTED_ID, 'audio/mpeg', 'audio.mp3')),
    restore,
    clear,
  })).rejects.toThrow('Select a video file for rendering');
  expect(restore).toHaveBeenCalledWith(PREVIOUS_ID);
  expect(clear).not.toHaveBeenCalled();
});

test('leaves the current selection untouched when the picker is cancelled', async () => {
  const restore = vi.fn();
  const clear = vi.fn();

  await expect(selectNativeRenderVideo({
    getCurrent: vi.fn(async () => descriptor(PREVIOUS_ID)),
    select: vi.fn(async () => null),
    restore,
    clear,
  })).resolves.toBeNull();
  expect(restore).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

test('keeps the actionable message when restoring the previous selection fails', async () => {
  const restore = vi.fn(async () => { throw new Error('The native media request is invalid'); });
  const clear = vi.fn();

  await expect(selectNativeRenderVideo({
    getCurrent: vi.fn(async () => descriptor(PREVIOUS_ID)),
    select: vi.fn(async () => descriptor(SELECTED_ID, 'audio/mpeg', 'audio.mp3')),
    restore,
    clear,
  })).rejects.toThrow('Select a video file for rendering');
  expect(restore).toHaveBeenCalledWith(PREVIOUS_ID);
  expect(clear).not.toHaveBeenCalled();
});

test('keeps the actionable message when clearing an empty previous selection fails', async () => {
  const restore = vi.fn();
  const clear = vi.fn(async () => { throw new Error('invalidMediaResponse'); });

  await expect(selectNativeRenderVideo({
    getCurrent: vi.fn(async () => null),
    select: vi.fn(async () => descriptor(SELECTED_ID, 'audio/mpeg', 'audio.mp3')),
    restore,
    clear,
  })).rejects.toThrow('Select a video file for rendering');
  expect(clear).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
});

test('keeps the actionable drop message when the rollback restore fails', async () => {
  const restore = vi.fn(async () => { throw new Error('The native media request is invalid'); });
  const clear = vi.fn();

  await expect(claimNativeRenderVideo('9b2c6b54-3a72-44d2-89e8-4979ad45e5f0', {
    getCurrent: vi.fn(async () => descriptor(PREVIOUS_ID)),
    claim: vi.fn(async () => descriptor(SELECTED_ID, 'audio/mpeg', 'audio.mp3')),
    restore,
    clear,
  })).rejects.toThrow('Drop a video file for rendering');
  expect(restore).toHaveBeenCalledWith(PREVIOUS_ID);
  expect(clear).not.toHaveBeenCalled();
});

test('claims an opaque native drop as a renderer video', async () => {
  const selected = descriptor(SELECTED_ID);
  const claim = vi.fn(async () => selected);
  await expect(claimNativeRenderVideo('9b2c6b54-3a72-44d2-89e8-4979ad45e5f0', {
    getCurrent: vi.fn(async () => descriptor(PREVIOUS_ID)),
    claim,
    restore: vi.fn(),
    clear: vi.fn(),
  })).resolves.toBe(selected);
  expect(claim).toHaveBeenCalledWith('9b2c6b54-3a72-44d2-89e8-4979ad45e5f0');
});
