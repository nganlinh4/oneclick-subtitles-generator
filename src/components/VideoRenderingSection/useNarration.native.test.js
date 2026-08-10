import { renderHook } from '@testing-library/react';

import {
  generateAlignedNarration,
  getAlignedNarrationArtifactId,
  getAlignedNarrationUrl,
} from '../../services/alignedNarrationService.js';
import { useNarration } from './useNarration';

vi.mock('../../services/alignedNarrationService.js', () => ({
  generateAlignedNarration: vi.fn(),
  getAlignedNarrationArtifactId: vi.fn(),
  getAlignedNarrationUrl: vi.fn(),
}));

const nativeResult = {
  subtitle_id: 7,
  success: true,
  nativeArtifactId: '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2',
  start: 0,
  end: 1,
};

describe('render narration native cache precedence', () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    window.isTauri = true;
    window.alignedNarrationCache = {
      url: 'http://localhost:3031/api/narration/audio/stale.m4a',
    };
    window.isAlignedNarrationAvailable = true;
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    delete window.isTauri;
    delete window.alignedNarrationCache;
    delete window.isAlignedNarrationAvailable;
    global.fetch = originalFetch;
  });

  test('ignores the stale window URL and returns only newly resolved native playback', async () => {
    getAlignedNarrationUrl
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('http://127.0.0.1:43111/asset/native?token=scoped');
    generateAlignedNarration.mockResolvedValue('aligned-preview://timeline');
    const { result } = renderHook(() => useNarration({
      selectedNarration: 'generated',
      narrationResults: [nativeResult],
    }));

    await expect(result.current.getNarrationAudioUrl())
      .resolves.toBe('http://127.0.0.1:43111/asset/native?token=scoped');
    expect(generateAlignedNarration).toHaveBeenCalledWith([nativeResult]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns the current native cache without regenerating', async () => {
    getAlignedNarrationUrl.mockReturnValue('http://127.0.0.1:43111/asset/current?token=scoped');
    const { result } = renderHook(() => useNarration({
      selectedNarration: 'generated',
      narrationResults: [nativeResult],
    }));

    await expect(result.current.getNarrationAudioUrl())
      .resolves.toBe('http://127.0.0.1:43111/asset/current?token=scoped');
    expect(generateAlignedNarration).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    new Error('alignment failed'),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  ])('propagates %s without falling back to the stale URL', async (failure) => {
    getAlignedNarrationUrl.mockReturnValue(null);
    generateAlignedNarration.mockRejectedValue(failure);
    const { result } = renderHook(() => useNarration({
      selectedNarration: 'generated',
      narrationResults: [nativeResult],
    }));

    await expect(result.current.getNarrationAudioUrl()).rejects.toBe(failure);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('resolves only the native artifact identity for render export', async () => {
    getAlignedNarrationArtifactId.mockReturnValue(nativeResult.nativeArtifactId);
    const { result } = renderHook(() => useNarration({
      selectedNarration: 'generated',
      narrationResults: [nativeResult],
    }));

    await expect(result.current.getNarrationArtifactId())
      .resolves.toBe(nativeResult.nativeArtifactId);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
