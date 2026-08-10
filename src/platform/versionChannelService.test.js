import {
  detectVersionChannel,
  switchVersionChannel,
} from './versionChannelService';

test('desktop channel comes from immutable build metadata without HTTP', async () => {
  const fetchRequest = vi.fn();
  await expect(detectVersionChannel({
    getVersion: async () => ({ branch: 'rewrite/tauri-rust' }),
    fetchRequest,
  })).resolves.toBe('main');
  expect(fetchRequest).not.toHaveBeenCalled();
});

test('only the explicit legacy branch maps to the old channel', async () => {
  await expect(detectVersionChannel({
    getVersion: async () => ({ branch: 'old_version' }),
  })).resolves.toBe('old_version');
});

test('desktop builds reject runtime Git mutation before any HTTP request', async () => {
  const fetchRequest = vi.fn();
  await expect(switchVersionChannel('old_version', { fetchRequest }))
    .rejects.toMatchObject({ code: 'versionSwitchUnavailable' });
  expect(fetchRequest).not.toHaveBeenCalled();
});

test('browser inspection uses build metadata and cannot mutate source control', async () => {
  const fetchRequest = vi.fn();

  await expect(detectVersionChannel({
    getVersion: async () => ({ branch: 'main' }),
    fetchRequest,
  })).resolves.toBe('main');
  await expect(switchVersionChannel('old_version', { fetchRequest }))
    .rejects.toMatchObject({ code: 'versionSwitchUnavailable' });

  expect(fetchRequest).not.toHaveBeenCalled();
});

test('invalid channel input is rejected before native or browser transport', async () => {
  const fetchRequest = vi.fn();
  await expect(switchVersionChannel('feature/unsafe', { fetchRequest }))
    .rejects.toMatchObject({ code: 'invalidVersionChannel' });
  expect(fetchRequest).not.toHaveBeenCalled();
});
