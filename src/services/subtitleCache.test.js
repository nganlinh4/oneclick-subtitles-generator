import { loadProjectSubtitles, saveProjectSubtitles } from '../platform/subtitleProjectStore';
import { getCachedSubtitles, saveSubtitlesToCache } from './subtitleCache';

vi.mock('../platform/subtitleProjectStore', () => ({
  loadProjectSubtitles: vi.fn(),
  saveProjectSubtitles: vi.fn(),
}));

beforeEach(() => {
  loadProjectSubtitles.mockReset();
  saveProjectSubtitles.mockReset();
  localStorage.clear();
});

it('uses project commands in Tauri without probing localhost or WebView storage', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Native' }];
  loadProjectSubtitles.mockResolvedValue(rows);
  saveProjectSubtitles.mockResolvedValue({ stateVersion: 1 });
  const storageSpy = vi.spyOn(Storage.prototype, 'getItem');

  await expect(getCachedSubtitles('cache-id', 'https://example.test/video')).resolves.toEqual(rows);
  await expect(saveSubtitlesToCache('cache-id', rows)).resolves.toEqual({ success: true });

  expect(loadProjectSubtitles).toHaveBeenCalledWith('cache-id');
  expect(saveProjectSubtitles).toHaveBeenCalledWith('cache-id', rows);
  expect(storageSpy).not.toHaveBeenCalled();
  storageSpy.mockRestore();
});
