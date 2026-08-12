import {
  UpdateServiceError,
  cancelDesktopUpdate,
  checkDesktopUpdate,
  getDesktopAppVersion,
  installDesktopUpdate,
  normalizeUpdateStatus,
} from './updateService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: vi.fn(),
}));

const configuredStatus = () => ({
  configured: true,
  currentVersion: '2.0.0',
  update: {
    version: '2.1.0-beta.1',
    publishedAt: '2026-08-10T03:04:05Z',
    notes: 'Signed release\nwith fixes.',
  },
});

describe('updateService', () => {
  test('checks one fixed native command and returns frozen bounded metadata', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(configuredStatus());
    const result = await checkDesktopUpdate({
      nativeRuntime: () => true,
      invokeCommand,
    });

    expect(invokeCommand).toHaveBeenCalledWith('app_update_check');
    expect(result).toEqual(configuredStatus());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.update)).toBe(true);
  });

  test('represents an intentionally unconfigured signing identity without network fallback', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      configured: false,
      currentVersion: '2.0.0',
      update: null,
    });
    await expect(checkDesktopUpdate({
      nativeRuntime: () => true,
      invokeCommand,
    })).resolves.toMatchObject({ configured: false, update: null });
  });

  test.each([
    { configured: false, currentVersion: '2.0.0', update: configuredStatus().update },
    { configured: true, currentVersion: 'v2.0.0', update: null },
    { configured: true, currentVersion: '2.0.0', update: { ...configuredStatus().update, url: 'https://attacker.invalid' } },
    { configured: true, currentVersion: '2.0.0', update: { ...configuredStatus().update, notes: `ok\u0000${'x'.repeat(3)}` } },
    { configured: true, currentVersion: '2.0.0', update: { ...configuredStatus().update, publishedAt: 'yesterday' } },
  ])('rejects malformed, injected, or contradictory update metadata %#', (value) => {
    expect(() => normalizeUpdateStatus(value)).toThrow(UpdateServiceError);
  });

  test('never falls back to browser transport outside Tauri', async () => {
    const invokeCommand = vi.fn();
    await expect(checkDesktopUpdate({
      nativeRuntime: () => false,
      invokeCommand,
    })).rejects.toMatchObject({ code: 'desktopRuntimeUnavailable' });
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  test('sanitizes transport failures without retaining their message or cause', async () => {
    const secret = 'private-token-in-transport';
    let thrown;
    try {
      await checkDesktopUpdate({
        nativeRuntime: () => true,
        invokeCommand: async () => {
          const error = new Error(secret);
          error.code = 'updaterUnavailable';
          throw error;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'updaterUnavailable',
      message: 'The update check could not be completed',
    });
    expect(thrown.cause).toBeUndefined();
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });

  test('reads and validates the installed semantic version from app_health', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      appVersion: '2.0.0',
      architecture: 'x86_64',
      platform: 'windows',
    });
    await expect(getDesktopAppVersion({
      nativeRuntime: () => true,
      invokeCommand,
    })).resolves.toBe('2.0.0');
    expect(invokeCommand).toHaveBeenCalledWith('app_health');
  });

  test('rejects extra host-health fields and non-semver versions', async () => {
    await expect(getDesktopAppVersion({
      nativeRuntime: () => true,
      invokeCommand: async () => ({
        appVersion: '2026.08.10-build',
        architecture: 'x86_64',
        platform: 'windows',
        path: 'C:\\private\\app.exe',
      }),
    })).rejects.toMatchObject({ code: 'invalidUpdateResponse' });
  });

  test('installs only the revalidated version over a strict bounded progress channel', async () => {
    class FakeChannel {
      constructor() { this.onmessage = null; }
    }
    const events = [];
    const invokeCommand = vi.fn(async (command, payload) => {
      if (command !== 'app_update_install') throw new Error('unexpected command');
      payload.onEvent.onmessage({ event: 'checking', version: '1.0.1' });
      payload.onEvent.onmessage({
        event: 'progress', downloadedBytes: 25, totalBytes: 100, basisPoints: 2500,
      });
      payload.onEvent.onmessage({ event: 'installing', version: '1.0.1' });
    });
    await installDesktopUpdate('1.0.1', {
      onChecking: (event) => events.push(event.event),
      onProgress: (event) => events.push(`${event.event}:${event.downloadedBytes}`),
      onInstalling: (event) => events.push(event.event),
    }, {
      nativeRuntime: () => true,
      invokeCommand,
      ChannelConstructor: FakeChannel,
    });
    expect(events).toEqual(['checking', 'progress:25', 'installing']);
    expect(invokeCommand).toHaveBeenCalledWith('app_update_install', {
      expectedVersion: '1.0.1', onEvent: expect.any(FakeChannel),
    });
  });

  test('fails closed and cancels on injected or non-monotonic installer events', async () => {
    class FakeChannel {
      constructor() { this.onmessage = null; }
    }
    const invokeCommand = vi.fn(async (command, payload) => {
      if (command === 'app_update_install') {
        payload.onEvent.onmessage({
          event: 'progress', downloadedBytes: 50, totalBytes: 100, basisPoints: 5000,
        });
        payload.onEvent.onmessage({
          event: 'progress', downloadedBytes: 40, totalBytes: 100, basisPoints: 4000,
        });
        return;
      }
      if (command === 'app_update_cancel') return true;
      throw new Error('unexpected command');
    });
    await expect(installDesktopUpdate('1.0.1', {}, {
      nativeRuntime: () => true,
      invokeCommand,
      ChannelConstructor: FakeChannel,
    })).rejects.toMatchObject({ code: 'invalidUpdateResponse' });
    expect(invokeCommand).toHaveBeenCalledWith('app_update_cancel', {
      expectedVersion: '1.0.1',
      reason: 'protocol',
    });
  });

  test('exposes cancellation only through the exact active version contract', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(true);
    await expect(cancelDesktopUpdate('1.0.1-rc.2', {
      nativeRuntime: () => true,
      invokeCommand,
    })).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith('app_update_cancel', {
      expectedVersion: '1.0.1-rc.2',
      reason: 'user',
    });
    await expect(cancelDesktopUpdate('../../evil.exe', {
      nativeRuntime: () => true,
      invokeCommand,
    })).rejects.toMatchObject({ code: 'invalidUpdateRequest' });
  });
});
