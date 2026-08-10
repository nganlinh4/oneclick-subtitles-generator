import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import { detectStartupMode } from './startupService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: vi.fn(),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  invokeDesktop.mockReset();
  isDesktopRuntime.mockReset();
  global.fetch = vi.fn();
});

afterAll(() => {
  global.fetch = originalFetch;
});

it('treats a responsive native host as full desktop mode', async () => {
  isDesktopRuntime.mockReturnValue(true);
  invokeDesktop.mockResolvedValue({ appVersion: '2.0.0', platform: 'windows' });

  await expect(detectStartupMode()).resolves.toEqual({
    backendAvailable: true,
    isVercelMode: false,
    health: { appVersion: '2.0.0', platform: 'windows' },
  });
  expect(invokeDesktop).toHaveBeenCalledWith('app_health');
  expect(global.fetch).not.toHaveBeenCalled();
});

it('fails closed in browser-only inspection without probing localhost', async () => {
  isDesktopRuntime.mockReturnValue(false);

  await expect(detectStartupMode()).resolves.toEqual({
    backendAvailable: false,
    isVercelMode: true,
  });
  expect(invokeDesktop).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

it('propagates native health failures without falling back to HTTP', async () => {
  isDesktopRuntime.mockReturnValue(true);
  const failure = new Error('Native health unavailable');
  invokeDesktop.mockRejectedValue(failure);

  await expect(detectStartupMode()).rejects.toBe(failure);
  expect(global.fetch).not.toHaveBeenCalled();
});
