import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addAllSitesUrlToHistory,
  addDouyinUrlToHistory,
  addSearchQueryToHistory,
  addYoutubeUrlToHistory,
  getAllSitesUrlHistory,
  getDouyinUrlHistory,
  getSearchQueryHistory,
  getYoutubeUrlHistory,
} from './historyUtils';

const VIDEO_ID = 'AbCdEfGhI_1';
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const CAPABILITY = 'http://127.0.0.1:49152/asset/13fba818-bbad-4c2c-8002-8d4a6a54c35d?token=private';

describe('bounded URL/search histories', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));
  });

  it('persists stable YouTube metadata but never a provider image capability', () => {
    addYoutubeUrlToHistory({
      id: VIDEO_ID,
      url: VIDEO_URL,
      title: 'A useful video',
      thumbnail: CAPABILITY,
    });

    expect(getYoutubeUrlHistory()).toEqual([{
      id: VIDEO_ID,
      url: VIDEO_URL,
      title: 'A useful video',
      thumbnail: '',
      timestamp: Date.now(),
    }]);
    expect(localStorage.getItem('youtube_url_history')).not.toContain('token=');
  });

  it('drops malformed, mismatched, duplicate, and excessive YouTube rows', () => {
    const valid = {
      id: VIDEO_ID,
      url: VIDEO_URL,
      title: 'Newest',
      thumbnail: CAPABILITY,
      timestamp: 3,
    };
    localStorage.setItem('youtube_url_history', JSON.stringify([
      null,
      { ...valid, id: 'wrong' },
      valid,
      { ...valid, title: 'Older duplicate', timestamp: 2 },
      { ...valid, id: 'ZyXwVuTsRq0', url: VIDEO_URL },
    ]));

    expect(getYoutubeUrlHistory()).toEqual([{ ...valid, thumbnail: '' }]);
    expect(localStorage.getItem('youtube_url_history')).not.toContain('private');
  });

  it('repairs non-array and oversized storage without throwing into the picker', () => {
    localStorage.setItem('youtube_search_history', JSON.stringify({ query: 'not-an-array' }));
    expect(getSearchQueryHistory()).toEqual([]);
    expect(localStorage.getItem('youtube_search_history')).toBeNull();

    localStorage.setItem('all_sites_url_history', 'x'.repeat((256 * 1024) + 1));
    expect(getAllSitesUrlHistory()).toEqual([]);
    expect(localStorage.getItem('all_sites_url_history')).toBeNull();
  });

  it('normalizes and de-duplicates bounded search queries case-insensitively', () => {
    addSearchQueryToHistory('  Cats  ');
    vi.setSystemTime(new Date('2026-08-15T00:00:01Z'));
    addSearchQueryToHistory('cats');
    addSearchQueryToHistory('ab');
    addSearchQueryToHistory('x'.repeat(501));

    expect(getSearchQueryHistory()).toEqual([{ query: 'cats', timestamp: Date.now() }]);
  });

  it('keeps only validated stable all-sites metadata and strips every thumbnail', () => {
    addAllSitesUrlToHistory({
      id: 'site_example_com_video_1',
      url: 'https://example.com/video/1',
      title: 'Example',
      thumbnail: CAPABILITY,
    });
    localStorage.setItem('all_sites_url_history', JSON.stringify([
      ...getAllSitesUrlHistory(),
      { id: '../bad', url: 'file:///private/video.mp4', title: 'Bad', timestamp: 1 },
    ]));

    expect(getAllSitesUrlHistory()).toEqual([{
      id: 'site_example_com_video_1',
      url: 'https://example.com/video/1',
      title: 'Example',
      thumbnail: '',
      timestamp: Date.now(),
    }]);
    expect(localStorage.getItem('all_sites_url_history')).not.toContain('token=');
  });

  it('bounds Douyin history and requires the stored ID to belong to the exact URL', () => {
    addDouyinUrlToHistory({
      id: '7460123456789012345',
      url: 'https://www.douyin.com/video/7460123456789012345',
      title: 'Douyin clip',
      thumbnail: CAPABILITY,
    });
    localStorage.setItem('douyin_url_history', JSON.stringify([
      ...getDouyinUrlHistory(),
      {
        id: 'wrong',
        url: 'https://www.douyin.com/video/7460123456789012345',
        title: 'Forged',
        timestamp: 1,
      },
    ]));

    expect(getDouyinUrlHistory()).toEqual([{
      id: '7460123456789012345',
      url: 'https://www.douyin.com/video/7460123456789012345',
      title: 'Douyin clip',
      thumbnail: '',
      timestamp: Date.now(),
    }]);
    expect(localStorage.getItem('douyin_url_history')).not.toContain('token=');
  });
});
