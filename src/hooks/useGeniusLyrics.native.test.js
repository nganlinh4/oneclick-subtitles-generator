import { act, renderHook } from '@testing-library/react';

import { fetchGeniusLyricsNative } from '../platform/providerService';
import useGeniusLyrics from './useGeniusLyrics';

vi.mock('../platform/providerService', () => ({
  fetchGeniusLyricsNative: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

it('fetches and cleans Genius lyrics through native IPC without WebView provider capabilities', async () => {
  fetchGeniusLyricsNative.mockResolvedValue({
    lyrics: '[Verse]\nFirst line\n\n[Chorus]\nSecond line',
    albumArtUrl: 'https://images.genius.com/cover.jpg',
  });

  const fetchBefore = globalThis.fetch;
  const openBefore = window.open;
  globalThis.fetch = vi.fn(() => {
    throw new Error('WebView provider fetch must not run');
  });
  window.open = vi.fn(() => {
    throw new Error('WebView provider popup must not open');
  });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('provider secret storage read attempted');
  });
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('provider secret storage write attempted');
  });

  try {
    const { result } = renderHook(() => useGeniusLyrics());
    let lyrics;
    await act(async () => {
      lyrics = await result.current.fetchLyrics('Artist', 'Song', true);
    });

    expect(lyrics).toEqual({
      lyrics: 'First line\nSecond line',
      albumArtUrl: 'https://images.genius.com/cover.jpg',
    });
    expect(fetchGeniusLyricsNative).toHaveBeenCalledWith({
      artist: 'Artist',
      song: 'Song',
      force: true,
    });
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
    globalThis.fetch = fetchBefore;
    window.open = openBefore;
  }
});
