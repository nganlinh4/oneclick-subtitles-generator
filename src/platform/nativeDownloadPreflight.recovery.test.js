// Downloader recovery after execution failures: live-channel updates, cooldown and coalescing.

import {
  recoverNativeDownloaderAfterFailure,
  resetNativeDownloaderRecoveryForTest,
} from './nativeDownloadPreflight';
import {
  catalog,
  completedEvent,
  presentation,
  runningJob,
  status,
  translate,
} from './nativeDownloadPreflightTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));


beforeEach(() => resetNativeDownloaderRecoveryForTest());

it('updates an installed yt-dlp after an execution failure without any prompt', async () => {
  const ui = presentation();
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => {
      handlers.onProgress({ operation: { basisPoints: 5_000 } });
      handlers.onCompleted(completedEvent(tool, job.id));
    });
    return job;
  });
  const installedStatus = status({
    'yt-dlp': {
      installed: true,
      state: 'installed',
      version: '2026.07.04',
      availableVersion: '2026.08.10',
      installedBytes: 10,
      activeRuntime: true,
    },
  });
  const updatedStatus = status({
    'yt-dlp': {
      installed: true,
      state: 'installed',
      version: '2026.08.10.235959',
      availableVersion: '2026.08.10.235959',
      installedBytes: 10,
      activeRuntime: true,
    },
  });
  const readStatus = vi.fn()
    .mockResolvedValueOnce(installedStatus)
    .mockResolvedValueOnce(updatedStatus);

  await expect(recoverNativeDownloaderAfterFailure({
    readCatalog: vi.fn(async () => catalog()),
    readStatus,
    install,
    presentation: ui,
    t: translate,
    now: () => 1_000_000,
  })).resolves.toEqual({ checked: true, updated: true, throttled: false });

  expect(install).toHaveBeenCalledWith('yt-dlp', expect.any(Object), expect.any(Object));
  expect(ui.dismiss).toHaveBeenCalled();
});

it('checks the live channel but does not report an unchanged verified yt-dlp as updated', async () => {
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id)));
    return job;
  });
  const installedStatus = status({
    'yt-dlp': {
      installed: true,
      state: 'installed',
      version: '2026.07.04',
      availableVersion: '2026.07.04',
      installedBytes: 10,
      activeRuntime: true,
    },
  });

  await expect(recoverNativeDownloaderAfterFailure({
    readCatalog: vi.fn(async () => catalog()),
    readStatus: vi.fn(async () => installedStatus),
    install,
    presentation: presentation(),
    t: translate,
    now: () => 1_500_000,
  })).resolves.toEqual({ checked: true, updated: false, throttled: false });

  expect(install).toHaveBeenCalledTimes(1);
});

it('does not consume the recovery cooldown while a failed job is still releasing its runtime', async () => {
  const releasing = status({
    'yt-dlp': {
      installed: true,
      state: 'installed',
      version: '2026.08.20.234504',
      installedBytes: 10,
      activeRuntime: false,
    },
  });
  const ready = status({
    'yt-dlp': {
      installed: true,
      state: 'installed',
      version: '2026.08.20.234504',
      installedBytes: 10,
      activeRuntime: true,
    },
  });
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id)));
    return job;
  });

  await expect(recoverNativeDownloaderAfterFailure({
    readCatalog: vi.fn(async () => catalog()),
    readStatus: vi.fn(async () => releasing),
    install,
    presentation: presentation(),
    t: translate,
    now: () => 1_750_000,
  })).resolves.toEqual({ checked: false, updated: false, throttled: false });

  await expect(recoverNativeDownloaderAfterFailure({
    readCatalog: vi.fn(async () => catalog()),
    readStatus: vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready),
    install,
    presentation: presentation(),
    t: translate,
    now: () => 1_750_001,
  })).resolves.toEqual({ checked: true, updated: false, throttled: false });
  expect(install).toHaveBeenCalledTimes(1);
});

it('coalesces and throttles repeated automatic recovery checks', async () => {
  const installedStatus = status({
    'yt-dlp': {
      installed: true,
      state: 'installed',
      version: '2026.07.04',
      availableVersion: '2026.08.10',
      installedBytes: 10,
      activeRuntime: true,
    },
  });
  const install = vi.fn(async (tool, handlers) => {
    const job = runningJob();
    queueMicrotask(() => handlers.onCompleted(completedEvent(tool, job.id, {
      restartRequired: false,
    })));
    return job;
  });
  const updatedStatus = status({
    'yt-dlp': {
      installed: true,
      state: 'installed',
      version: '2026.08.10.235959',
      availableVersion: '2026.08.10.235959',
      installedBytes: 10,
      activeRuntime: true,
    },
  });
  const readStatus = vi.fn()
    .mockResolvedValueOnce(installedStatus)
    .mockResolvedValueOnce(updatedStatus);
  const options = {
    readCatalog: vi.fn(async () => catalog()),
    readStatus,
    install,
    presentation: presentation(),
    t: translate,
    now: () => 2_000_000,
  };
  const first = recoverNativeDownloaderAfterFailure(options);
  const second = recoverNativeDownloaderAfterFailure(options);
  await expect(first).resolves.toEqual({ checked: true, updated: true, throttled: false });
  await expect(second).resolves.toEqual({ checked: true, updated: true, throttled: false });
  await expect(recoverNativeDownloaderAfterFailure(options))
    .resolves.toEqual({ checked: true, updated: true, throttled: true });
  expect(install).toHaveBeenCalledTimes(1);
});
