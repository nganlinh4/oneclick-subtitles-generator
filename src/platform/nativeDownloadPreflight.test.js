import fs from 'fs';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';

import {
  NativeDownloadPreflightError,
  createNativeDownloadPreflight,
} from './nativeDownloadPreflight';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const catalog = () => ({
  schemaVersion: 1,
  tools: [
    { id: 'media-tools', label: 'FFmpeg and FFprobe', license: 'GPL-2.0-or-later' },
    { id: 'yt-dlp', label: 'yt-dlp', license: 'GPL-3.0-or-later' },
    { id: 'deno', label: 'Deno', license: 'MIT' },
  ],
});

const statusEntry = (id, overrides = {}) => ({
  id,
  label: id === 'deno' ? 'Deno' : id,
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
  ...overrides,
});

const status = (overrides = {}) => ({
  schemaVersion: 1,
  tools: [
    statusEntry('media-tools'),
    statusEntry('yt-dlp', overrides['yt-dlp']),
    statusEntry('deno', overrides.deno),
  ],
});

const runningJob = () => ({
  id: uuidv7(),
  kind: 'installEngine',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
});

const completedEvent = (tool, id, overrides = {}) => ({
  event: 'completed',
  job: {
    id,
    kind: 'installEngine',
    state: 'succeeded',
    progress: { basisPoints: 10_000 },
    sequence: 2,
  },
  tool,
  action: 'install',
  restartRequired: true,
  deferred: false,
  ...overrides,
});

const presentation = (approved = true) => ({
  confirm: vi.fn(() => approved),
  notify: vi.fn(),
  dismiss: vi.fn(),
});

const translate = (key, values = {}) => [key, values.tools, values.tool, values.percent]
  .filter((value) => value !== undefined)
  .join('|');

const service = (overrides = {}) => createNativeDownloadPreflight({
  readCatalog: vi.fn(async () => catalog()),
  readStatus: vi.fn(async () => status()),
  install: vi.fn(),
  presentation: presentation(),
  t: translate,
  ...overrides,
});

it('is production-reachable only through typed download preflights and has no network or storage authority', () => {
  const source = fs.readFileSync(path.join(__dirname, 'nativeDownloadPreflight.js'), 'utf8');
  const downloadSource = fs.readFileSync(path.join(__dirname, 'downloadService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toMatch(/https?:\/\//i);
  expect(downloadSource).toContain('ensureNativeDownloadInspectionReady');
  expect(downloadSource).toContain('ensureNativeDownloadReady');
});

it('does nothing when the startup-snapshotted runtime is already ready', async () => {
  const readCatalog = vi.fn();
  const readStatus = vi.fn();
  const preflight = service({ readCatalog, readStatus });

  await expect(preflight.ensureInspectionReady({ inspectAvailable: true }))
    .resolves.toEqual({ ready: true });
  await expect(preflight.ensureDownloadReady({ available: true }))
    .resolves.toEqual({ ready: true });
  expect(readCatalog).not.toHaveBeenCalled();
  expect(readStatus).not.toHaveBeenCalled();
});

it('requires explicit informed consent, installs sequentially, reports progress, then requires restart', async () => {
  const ui = presentation();
  const started = [];
  const progress = [];
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => {
      handlers.onProgress({ operation: { basisPoints: 5_000 } });
      handlers.onCompleted(completedEvent(tool, job.id));
    });
    return job;
  });
  const preflight = service({ install, presentation: ui });

  await expect(preflight.ensureInspectionReady(
    { inspectAvailable: false },
    {
      onJobStarted: (job) => started.push(job.id),
      onProgress: (percent) => progress.push(percent),
    }
  )).rejects.toMatchObject({ code: 'nativeToolRestartRequired' });

  expect(ui.confirm).toHaveBeenCalledTimes(1);
  expect(ui.confirm.mock.calls[0][0]).toContain('yt-dlp (GPL-3.0-or-later)');
  expect(ui.confirm.mock.calls[0][0]).toContain('Deno (MIT)');
  expect(ui.confirm.mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]);
  expect(install.mock.calls.map(([tool]) => tool)).toEqual(['yt-dlp', 'deno']);
  expect(started).toHaveLength(2);
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(100);
  expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({
    type: 'info',
    button: expect.objectContaining({ text: 'download.nativeTools.cancel' }),
  }));
  expect(ui.notify).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'warning',
    button: undefined,
  }));
});

it('declining consent downloads nothing and reports a typed result', async () => {
  const ui = presentation(false);
  const install = vi.fn();
  const preflight = service({ install, presentation: ui });

  await expect(preflight.ensureInspectionReady({ inspectAvailable: false }))
    .rejects.toMatchObject({ code: 'nativeToolConsentDeclined' });
  expect(install).not.toHaveBeenCalled();
  expect(ui.notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'warning' }));
});

it('the existing keyed-toast cancel action aborts the active native job', async () => {
  const ui = presentation();
  const install = vi.fn((tool, handlers, { signal }) => {
    const job = runningJob();
    signal.addEventListener('abort', () => handlers.onCancelled({
      event: 'cancelled', tool, action: 'install', job,
    }), { once: true });
    return Promise.resolve(job);
  });
  const preflight = service({ install, presentation: ui });
  const pending = preflight.ensureInspectionReady({ inspectAvailable: false });

  await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({
    button: expect.objectContaining({ onClick: expect.any(Function) }),
  })));
  const progressToast = ui.notify.mock.calls
    .map(([notice]) => notice)
    .find((notice) => typeof notice.button?.onClick === 'function');
  progressToast.button.onClick();

  await expect(pending).rejects.toMatchObject({ code: 'nativeToolCancelled' });
  expect(install.mock.calls[0][2].signal.aborted).toBe(true);
});

it('fails closed and cancels native work when the Channel never returns a terminal event', async () => {
  const install = vi.fn(async () => runningJob());
  const preflight = service({ install, installTimeoutMs: 5 });

  await expect(preflight.ensureInspectionReady({ inspectAvailable: false }))
    .rejects.toMatchObject({ code: 'nativeToolInstallFailed' });
  expect(install.mock.calls[0][2].signal.aborted).toBe(true);
});

it('deduplicates concurrent user actions and exposes programmatic cancellation', async () => {
  const ui = presentation();
  const install = vi.fn((tool, handlers, { signal }) => {
    const job = runningJob();
    signal.addEventListener('abort', () => handlers.onCancelled({}), { once: true });
    return Promise.resolve(job);
  });
  const preflight = service({ install, presentation: ui });
  const first = preflight.ensureInspectionReady({ inspectAvailable: false });
  const second = preflight.ensureInspectionReady({ inspectAvailable: false });

  await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  expect(preflight.cancelActive()).toBe(true);
  await expect(first).rejects.toMatchObject({ code: 'nativeToolCancelled' });
  await expect(second).rejects.toMatchObject({ code: 'nativeToolCancelled' });
  expect(ui.confirm).toHaveBeenCalledTimes(1);
  expect(preflight.cancelActive()).toBe(false);
});

it('fails closed for inactive, corrupt, busy, unhealthy, and unavailable runtime states', async () => {
  const cases = [
    {
      overrides: {
        'yt-dlp': {
          state: 'installed', installed: true, version: '2026.07.04', installedBytes: 10,
          restartRequired: true,
        },
        deno: {
          state: 'installed', installed: true, version: '2.9.5', installedBytes: 10,
          restartRequired: true,
        },
      },
      code: 'nativeToolRestartRequired',
    },
    { overrides: { deno: { state: 'corrupt' } }, code: 'nativeToolCorrupt' },
    { overrides: { deno: { operation: { job: {} } } }, code: 'nativeToolBusy' },
    { overrides: { deno: { deliveryAvailable: false, state: 'unavailable' } }, code: 'nativeToolUnavailable' },
    {
      overrides: {
        'yt-dlp': {
          state: 'installed', installed: true, version: '2026.07.04', installedBytes: 10,
          activeRuntime: true,
        },
        deno: {
          state: 'installed', installed: true, version: '2.9.5', installedBytes: 10,
          activeRuntime: true,
        },
      },
      code: 'nativeToolHealthFailed',
    },
  ];

  for (const fixture of cases) {
    const preflight = service({ readStatus: vi.fn(async () => status(fixture.overrides)) });
    await expect(preflight.ensureInspectionReady({ inspectAvailable: false }))
      .rejects.toMatchObject({ code: fixture.code });
  }
});

it('reports the withheld media-tool delivery without offering or starting an install', async () => {
  const ui = presentation();
  const install = vi.fn();
  const preflight = service({ install, presentation: ui });

  await expect(preflight.ensureDownloadReady({
    available: false,
    inspectAvailable: true,
    reason: 'mediaToolsUnavailable',
  })).rejects.toMatchObject({ code: 'nativeMediaToolsUnavailable' });
  expect(ui.confirm).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
  expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});

it('rejects invalid options and a hostile completion that claims immediate activation', async () => {
  const preflight = service();
  await expect(preflight.ensureInspectionReady({ inspectAvailable: false }, { extra: true }))
    .rejects.toBeInstanceOf(NativeDownloadPreflightError);

  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id, {
      restartRequired: false,
    })));
    return job;
  });
  const hostile = service({ install });
  await expect(hostile.ensureInspectionReady({ inspectAvailable: false }))
    .rejects.toMatchObject({ code: 'nativeToolInstallFailed' });
});
