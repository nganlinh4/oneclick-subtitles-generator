import fs from 'fs';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import {
  NATIVE_TOOL_IDS,
  NativeToolsServiceError,
  createNativeToolsService,
  normalizeNativeToolEvent,
  normalizeNativeToolsCatalog,
  normalizeNativeToolsStatus,
} from './nativeToolsService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

class TestChannel {
  onmessage = () => {};

  emit(value) {
    this.onmessage(value);
  }
}

const job = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'installEngine',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

const catalog = () => ({
  schemaVersion: 1,
  tools: [
    { id: 'media-tools', label: 'FFmpeg and FFprobe', license: 'GPL-2.0-or-later' },
    { id: 'yt-dlp', label: 'yt-dlp', license: 'GPL-3.0-or-later' },
    { id: 'deno', label: 'Deno', license: 'MIT' },
  ],
});

const status = () => ({
  schemaVersion: 1,
  tools: NATIVE_TOOL_IDS.map((id) => ({
    id,
    label: id === 'media-tools' ? 'FFmpeg and FFprobe' : id,
    deliveryAvailable: id !== 'media-tools',
    installed: false,
    state: id === 'media-tools' ? 'unavailable' : 'missing',
    version: null,
    availableVersion: id === 'yt-dlp' ? '2026.07.04' : id === 'deno' ? '2.9.5' : null,
    installedBytes: 0,
    activeRuntime: false,
    pendingRemoval: false,
    restartRequired: false,
    operation: null,
  })),
});

const operation = (snapshot, overrides = {}) => ({
  job: snapshot,
  tool: 'yt-dlp',
  action: 'install',
  phase: 'downloading',
  basisPoints: snapshot.progress.basisPoints,
  bytesDone: 1,
  totalBytes: 10,
  ...overrides,
});

const service = (overrides = {}) => createNativeToolsService({
  invokeCommand: vi.fn(),
  ChannelConstructor: TestChannel,
  isNativeRuntime: () => true,
  ...overrides,
});

it('keeps the frontend boundary free of network, storage, and private transport fields', () => {
  const source = fs.readFileSync(path.join(__dirname, 'nativeToolsService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toMatch(/https?:\/\//i);
  expect(source).not.toMatch(/\b(path|url|file|base64|buffer)\s*:/i);
});

it('validates and canonically orders the closed catalog and status', () => {
  const rawCatalog = catalog();
  rawCatalog.tools.reverse();
  expect(normalizeNativeToolsCatalog(rawCatalog).tools.map(({ id }) => id))
    .toEqual(NATIVE_TOOL_IDS);

  const rawStatus = status();
  rawStatus.tools.reverse();
  const normalized = normalizeNativeToolsStatus(rawStatus);
  expect(normalized.tools.map(({ id }) => id)).toEqual(NATIVE_TOOL_IDS);
  expect(normalized.tools[0]).toEqual(expect.objectContaining({
    id: 'media-tools', state: 'unavailable', deliveryAvailable: false,
  }));
  expect(Object.isFrozen(normalized.tools)).toBe(true);
});

it('rejects duplicates, extras, contradictory runtime state, and private event diagnostics', () => {
  const duplicate = status();
  duplicate.tools[1].id = 'deno';
  expect(() => normalizeNativeToolsStatus(duplicate)).toThrow(NativeToolsServiceError);
  expect(() => normalizeNativeToolsStatus({ ...status(), privatePath: 'hidden' }))
    .toThrow(NativeToolsServiceError);
  const contradictory = status();
  contradictory.tools[1].pendingRemoval = true;
  contradictory.tools[1].restartRequired = true;
  expect(() => normalizeNativeToolsStatus(contradictory)).toThrow(NativeToolsServiceError);
  expect(() => normalizeNativeToolEvent({
    event: 'failed',
    job: null,
    tool: 'yt-dlp',
    action: 'install',
    error: { code: 'nativeToolStorage', message: 'Unavailable', diagnostics: 'hidden' },
  })).toThrow(NativeToolsServiceError);
});

it('normalizes strict progress and restart-aware terminal events', () => {
  const id = uuidv7();
  const running = job({ id, progress: { basisPoints: 100 }, sequence: 2 });
  expect(normalizeNativeToolEvent({
    event: 'progress',
    operation: operation(running, { basisPoints: 100 }),
  })).toEqual(expect.objectContaining({ event: 'progress' }));
  expect(normalizeNativeToolEvent({
    event: 'completed',
    job: job({
      id,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 3,
    }),
    tool: 'yt-dlp',
    action: 'remove',
    restartRequired: true,
    deferred: true,
  })).toEqual(expect.objectContaining({ restartRequired: true, deferred: true }));
});

it('invokes the four user-reachable commands and validates cancellation identity', async () => {
  const initial = job();
  let installChannel;
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'native_tools_catalog') return catalog();
    if (command === 'native_tools_status') return status();
    if (command === 'native_tool_install') {
      installChannel = args.onEvent;
      return initial;
    }
    if (command === 'native_tool_cancel') {
      return job({ id: args.jobId, state: 'cancelling', sequence: 2 });
    }
    return null;
  });
  const nativeTools = service({ invokeCommand });

  await nativeTools.getNativeToolsCatalog();
  await nativeTools.getNativeToolsStatus();
  await nativeTools.installNativeTool('yt-dlp');
  await nativeTools.cancelNativeToolJob(initial.id);

  expect(invokeCommand).toHaveBeenNthCalledWith(1, 'native_tools_catalog', {});
  expect(invokeCommand).toHaveBeenNthCalledWith(2, 'native_tools_status', {});
  expect(invokeCommand).toHaveBeenNthCalledWith(3, 'native_tool_install', {
    tool: 'yt-dlp', onEvent: installChannel,
  });
  expect(invokeCommand).toHaveBeenNthCalledWith(4, 'native_tool_cancel', {
    jobId: initial.id,
  });
});

it('buffers early progress, rejects mismatched events, and cancels on abort', async () => {
  const initial = job();
  let resolveStart;
  let channel;
  const onProgress = vi.fn();
  const onProtocolError = vi.fn();
  const invokeCommand = vi.fn((command, args) => {
    if (command === 'native_tool_install') {
      channel = args.onEvent;
      channel.emit({
        event: 'progress',
        operation: operation(job({
          id: initial.id, progress: { basisPoints: 100 }, sequence: 2,
        }), { basisPoints: 100 }),
      });
      return new Promise((resolve) => { resolveStart = resolve; });
    }
    return Promise.resolve(job({ id: initial.id, state: 'cancelling', sequence: 4 }));
  });
  const nativeTools = service({ invokeCommand });
  const controller = new AbortController();
  const started = nativeTools.installNativeTool('yt-dlp', { onProgress, onProtocolError }, {
    signal: controller.signal,
  });
  resolveStart(initial);
  await started;
  expect(onProgress).toHaveBeenCalledTimes(1);

  channel.emit({
    event: 'progress',
    operation: operation(job({ id: uuidv7(), progress: { basisPoints: 200 }, sequence: 3 }), {
      basisPoints: 200,
    }),
  });
  await Promise.resolve();
  expect(onProtocolError).toHaveBeenCalledTimes(1);

  const second = job();
  const abortInvoke = vi.fn(async (command, args) => (
    command === 'native_tool_install'
      ? second
      : job({ id: args.jobId, state: 'cancelling', sequence: 2 })
  ));
  const abortService = service({ invokeCommand: abortInvoke });
  const abortController = new AbortController();
  await abortService.installNativeTool('yt-dlp', undefined, { signal: abortController.signal });
  abortController.abort();
  await Promise.resolve();
  expect(abortInvoke).toHaveBeenCalledWith('native_tool_cancel', { jobId: second.id });
});

it('fails closed outside Tauri and rejects invalid tools before invocation', async () => {
  const invokeCommand = vi.fn();
  const nativeTools = createNativeToolsService({
    invokeCommand,
    ChannelConstructor: TestChannel,
    isNativeRuntime: () => false,
  });
  await expect(nativeTools.getNativeToolsCatalog())
    .rejects.toMatchObject({ code: 'desktopNativeToolsRequired' });
  await expect(nativeTools.getNativeToolsStatus())
    .rejects.toMatchObject({ code: 'desktopNativeToolsRequired' });
  await expect(nativeTools.installNativeTool('unknown'))
    .rejects.toMatchObject({ code: 'desktopNativeToolsRequired' });
  expect(invokeCommand).not.toHaveBeenCalled();

  const local = service({ invokeCommand });
  await expect(local.installNativeTool('unknown'))
    .rejects.toMatchObject({ code: 'invalidNativeToolRequest' });
  await expect(local.cancelNativeToolJob('not-a-v7'))
    .rejects.toMatchObject({ code: 'invalidNativeToolRequest' });
  expect(invokeCommand).not.toHaveBeenCalled();
});
