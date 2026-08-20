import { v7 as uuidv7 } from 'uuid';

import { invokeDesktop, isDesktopRuntime } from '../platform/desktopRuntime';
import { cancelDownloadOnly } from './downloadOnlyUtils';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('../platform/desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  isDesktopRuntime.mockReturnValue(true);
});

test.each(['downloadMedia', 'exportMedia'])(
  'cancels a durable native %s job without using the loopback server',
  async (kind) => {
    const id = uuidv7();
    invokeDesktop.mockResolvedValue({ id, kind, state: 'cancelling' });

    await expect(cancelDownloadOnly(id)).resolves.toBe(true);
    expect(invokeDesktop).toHaveBeenCalledWith('job_cancel', { id });
  }
);

test('rejects malformed IDs before native invocation', async () => {
  await expect(cancelDownloadOnly('legacy-video-id')).resolves.toBe(false);
  expect(invokeDesktop).not.toHaveBeenCalled();
});

test('fails closed on a mismatched native job response', async () => {
  const id = uuidv7();
  invokeDesktop.mockResolvedValue({ id: uuidv7(), kind: 'exportMedia', state: 'cancelling' });

  await expect(cancelDownloadOnly(id)).resolves.toBe(false);
});
