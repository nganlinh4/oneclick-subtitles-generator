import { beforeEach, expect, it, vi } from 'vitest';

import { addYoutubeUrlToHistory, getYoutubeUrlHistory } from '../../utils/historyUtils';
import { handleSelectFromHistory, loadHistory } from './urlHistory';

const IMAGE_CAPABILITY = 'http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174000?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const getVideoThumbnail = vi.fn().mockResolvedValue(IMAGE_CAPABILITY);

vi.mock('../../platform/desktopYoutubeService', () => ({
  getVideoThumbnail: (...args) => getVideoThumbnail(...args),
}));

beforeEach(() => {
  localStorage.clear();
  getVideoThumbnail.mockClear();
});

it('never persists provider or process-scoped thumbnail URLs', () => {
  addYoutubeUrlToHistory({
    id: 'AbCdEfGhI_1',
    url: 'https://www.youtube.com/watch?v=AbCdEfGhI_1',
    title: 'Video',
    thumbnail: IMAGE_CAPABILITY,
  });
  expect(JSON.parse(localStorage.getItem('youtube_url_history'))[0].thumbnail).toBe('');

  localStorage.setItem('youtube_url_history', JSON.stringify([{
    id: 'AbCdEfGhI_1',
    url: 'https://www.youtube.com/watch?v=AbCdEfGhI_1',
    title: 'Legacy',
    thumbnail: 'https://img.youtube.com/vi/AbCdEfGhI_1/0.jpg',
    timestamp: 1,
  }]));
  expect(getYoutubeUrlHistory()[0].thumbnail).toBe('');
  expect(JSON.parse(localStorage.getItem('youtube_url_history'))[0].thumbnail).toBe('');
});

it('hydrates history and selection only through the native ID command', async () => {
  localStorage.setItem('youtube_url_history', JSON.stringify([{
    id: 'AbCdEfGhI_1',
    url: 'https://www.youtube.com/watch?v=AbCdEfGhI_1',
    title: 'Video',
    thumbnail: '',
    timestamp: 10,
  }]));
  const setHistory = vi.fn();
  await loadHistory(setHistory);
  expect(setHistory).toHaveBeenLastCalledWith([
    expect.objectContaining({ thumbnail: IMAGE_CAPABILITY, source: 'youtube' }),
  ]);
  const hydratedHistoryItem = setHistory.mock.lastCall[0][0];

  const handlers = {
    setUrl: vi.fn(),
    setSelectedVideo: vi.fn(),
    setUrlType: vi.fn(),
    setShowHistory: vi.fn(),
  };
  await handleSelectFromHistory(hydratedHistoryItem, handlers);
  expect(getVideoThumbnail).toHaveBeenCalledWith('AbCdEfGhI_1');
  expect(handlers.setSelectedVideo).toHaveBeenCalledWith(expect.objectContaining({
    thumbnail: IMAGE_CAPABILITY,
  }));
});
