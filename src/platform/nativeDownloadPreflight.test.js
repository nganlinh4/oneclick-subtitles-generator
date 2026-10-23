import fs from 'fs';
import path from 'path';

import {
  NativeDownloadPreflightError,
  resetNativeDownloaderRecoveryForTest,
} from './nativeDownloadPreflight';
import {
  completedEvent,
  presentation,
  readyStatus,
  runningJob,
  service,
  status,
} from './nativeDownloadPreflightTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));


beforeEach(() => resetNativeDownloaderRecoveryForTest());

it('is production-reachable only through typed download preflights and has no network or storage authority', () => {
  const source = fs.readFileSync(path.join(__dirname, 'nativeDownloadPreflight.js'), 'utf8');
  const downloadSource = fs.readFileSync(path.join(__dirname, 'downloadService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toMatch(/https?:\/\//i);
  expect(source).not.toMatch(/window\.confirm|presentation\.confirm|nativeToolConsentDeclined/);
  expect(downloadSource).toContain('ensureNativeDownloadInspectionReady');
  expect(downloadSource).toContain('ensureNativeDownloadReady');
});

it('uses the verified active downloader for inspection without mutating its runtime', async () => {
  const readCatalog = vi.fn();
  const readStatus = vi.fn();
  const refreshDownloader = vi.fn().mockResolvedValue({ updated: false, throttled: false });
  const preflight = service({ readCatalog, readStatus, refreshDownloader });

  await expect(preflight.ensureInspectionReady({ inspectAvailable: true }))
    .resolves.toEqual({ ready: true });
  await expect(preflight.ensureDownloadReady({ available: true }))
    .resolves.toEqual({ ready: true });
  expect(readCatalog).not.toHaveBeenCalled();
  expect(readStatus).not.toHaveBeenCalled();
  expect(refreshDownloader).not.toHaveBeenCalled();
});

it('does not invoke even a failing updater before a healthy inspection', async () => {
  const refreshDownloader = vi.fn().mockRejectedValue(new Error('offline'));
  const preflight = service({ refreshDownloader });

  await expect(preflight.ensureInspectionReady({ inspectAvailable: true }))
    .resolves.toEqual({ ready: true });
  expect(refreshDownloader).not.toHaveBeenCalled();
});

it.each([
  ['downloaderUnavailable', 'yt-dlp'],
  ['downloaderHealthCheckFailed', 'yt-dlp'],
  ['javascriptRuntimeUnavailable', 'deno'],
])('repairs the installed package whose consumer is unhealthy for %s', async (reason, expectedTool) => {
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id)));
    return job;
  });
  const readStatus = vi.fn(async () => readyStatus());
  const preflight = service({ install, readStatus });

  await expect(preflight.ensureInspectionReady({ inspectAvailable: false, reason }))
    .resolves.toEqual({ ready: true });

  expect(install).toHaveBeenCalledTimes(1);
  expect(install).toHaveBeenCalledWith(expectedTool, expect.any(Object), expect.any(Object));
  expect(readStatus).toHaveBeenCalledTimes(2);
});

it('automatically installs the required batch in parallel and reports aggregate progress', async () => {
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
  const preflight = service({
    install,
    presentation: ui,
    readStatus: vi.fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValue(readyStatus()),
  });

  await expect(preflight.ensureInspectionReady(
    { inspectAvailable: false },
    {
      onJobStarted: (job) => started.push(job.id),
      onProgress: (percent) => progress.push(percent),
    }
  )).resolves.toEqual({ ready: true });

  expect(install.mock.calls.map(([tool]) => tool)).toEqual(['media-tools', 'yt-dlp', 'deno']);
  expect(started).toHaveLength(3);
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(100);
  expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({
    type: 'info',
    button: expect.objectContaining({ text: 'download.nativeTools.cancel' }),
  }));
  expect(new Set(ui.notify.mock.calls.map(([notice]) => notice.key))).toEqual(new Set([
    'native-download-tool-preflight:media-tools',
    'native-download-tool-preflight:yt-dlp',
    'native-download-tool-preflight:deno',
  ]));
  expect(ui.notify.mock.calls.map(([notice]) => notice.message)).toEqual(expect.arrayContaining([
    expect.stringContaining('FFmpeg and FFprobe|0'),
    expect.stringContaining('yt-dlp|0'),
    expect.stringContaining('Deno|0'),
  ]));
  expect(ui.dismiss).toHaveBeenCalled();
});

it('never asks for approval before starting the verified on-demand install', async () => {
  const confirm = vi.fn(() => {
    throw new Error('approval must not be consulted');
  });
  const ui = { ...presentation(), confirm };
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id)));
    return job;
  });
  const preflight = service({
    install,
    presentation: ui,
    readStatus: vi.fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValue(readyStatus()),
  });

  await expect(preflight.ensureInspectionReady({ inspectAvailable: false }))
    .resolves.toEqual({ ready: true });
  expect(confirm).not.toHaveBeenCalled();
  expect(install).toHaveBeenCalledTimes(3);
  expect(ui.dismiss).toHaveBeenCalled();
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

  await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(3));
  expect(preflight.cancelActive()).toBe(true);
  await expect(first).rejects.toMatchObject({ code: 'nativeToolCancelled' });
  await expect(second).rejects.toMatchObject({ code: 'nativeToolCancelled' });
  expect(preflight.cancelActive()).toBe(false);
});

it('fails closed for pending removal, corrupt, busy, and unavailable runtime states', async () => {
  const cases = [
    {
      overrides: {
        'media-tools': {
          state: 'installed', installed: true, version: '8.1.2', installedBytes: 10,
          activeRuntime: true,
        },
        'yt-dlp': {
          state: 'installed', installed: true, version: '2026.07.04', installedBytes: 10,
          activeRuntime: true,
        },
        deno: {
          state: 'installed', installed: true, version: '2.9.5', installedBytes: 10,
          restartRequired: true, pendingRemoval: true,
        },
      },
      code: 'nativeToolHealthFailed',
    },
    { overrides: { deno: { state: 'corrupt' } }, code: 'nativeToolCorrupt' },
    { overrides: { deno: { operation: { job: {} } } }, code: 'nativeToolBusy' },
    { overrides: { deno: { deliveryAvailable: false, state: 'unavailable' } }, code: 'nativeToolUnavailable' },
  ];

  for (const fixture of cases) {
    const preflight = service({ readStatus: vi.fn(async () => status(fixture.overrides)) });
    await expect(preflight.ensureInspectionReady({ inspectAvailable: false }))
      .rejects.toMatchObject({ code: fixture.code });
  }
});

it('repairs installed but inactive tools and activates them without a restart', async () => {
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id)));
    return job;
  });
  const preflight = service({
    install,
    readStatus: vi.fn()
      .mockResolvedValueOnce(status({
        'media-tools': readyStatus().tools[0],
        'yt-dlp': {
          state: 'installed', installed: true, version: '2026.07.04', installedBytes: 10,
          activeRuntime: false, restartRequired: true,
        },
        deno: {
          state: 'installed', installed: true, version: '2.9.5', installedBytes: 10,
          activeRuntime: false, restartRequired: true,
        },
      }))
      .mockResolvedValue(readyStatus()),
  });

  await expect(preflight.ensureInspectionReady({ inspectAvailable: false }))
    .resolves.toEqual({ ready: true });
  expect(install).toHaveBeenCalledTimes(2);
  expect(install.mock.calls.map(([tool]) => tool).sort()).toEqual(['deno', 'yt-dlp']);
});

it('reports a platform without media-tool delivery without starting an install', async () => {
  const ui = presentation();
  const install = vi.fn();
  const preflight = service({
    install,
    presentation: ui,
    readStatus: vi.fn(async () => status({
      'media-tools': { deliveryAvailable: false, state: 'unavailable' },
    })),
  });

  await expect(preflight.ensureDownloadReady({
    available: false,
    inspectAvailable: true,
    reason: 'mediaToolsUnavailable',
  })).rejects.toMatchObject({ code: 'nativeToolUnavailable' });
  expect(install).not.toHaveBeenCalled();
  expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});

it('offers the reviewed media-tool download only when the current platform catalog provides it', async () => {
  const ui = presentation();
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id)));
    return job;
  });
  const preflight = service({
    install,
    presentation: ui,
    readStatus: vi.fn()
      .mockResolvedValueOnce(status({
        'media-tools': {
          deliveryAvailable: true,
          state: 'missing',
          availableVersion: '8.1.2',
        },
        'yt-dlp': readyStatus().tools[1],
        deno: readyStatus().tools[2],
      }))
      .mockResolvedValue(readyStatus()),
  });

  await expect(preflight.ensureDownloadReady({
    available: false,
    inspectAvailable: true,
    reason: 'mediaToolsUnavailable',
  })).resolves.toEqual({ ready: true });
  expect(install).toHaveBeenCalledWith('media-tools', expect.any(Object), expect.any(Object));
});

it('coalesces media-processing preflight and installs only the reviewed media tool', async () => {
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id)));
    return job;
  });
  const preflight = service({
    install,
    readStatus: vi.fn()
      .mockResolvedValueOnce(status({
        'media-tools': {
          deliveryAvailable: true,
          state: 'missing',
          availableVersion: '8.1.2',
        },
        'yt-dlp': readyStatus().tools[1],
        deno: readyStatus().tools[2],
      }))
      .mockResolvedValue(readyStatus()),
  });

  await expect(Promise.all([
    preflight.ensureMediaToolsReady(),
    preflight.ensureMediaToolsReady(),
    preflight.ensureMediaToolsReady(),
  ])).resolves.toEqual([{ ready: true }, { ready: true }, { ready: true }]);
  expect(install).toHaveBeenCalledTimes(1);
  expect(install).toHaveBeenCalledWith('media-tools', expect.any(Object), expect.any(Object));
});

it('rejects invalid options and a hostile completion that still requires restart', async () => {
  const preflight = service();
  await expect(preflight.ensureInspectionReady({ inspectAvailable: false }, { extra: true }))
    .rejects.toBeInstanceOf(NativeDownloadPreflightError);

  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id, {
      restartRequired: true,
    })));
    return job;
  });
  const hostile = service({ install });
  await expect(hostile.ensureInspectionReady({ inspectAvailable: false }))
    .rejects.toMatchObject({ code: 'nativeToolInstallFailed' });
});

