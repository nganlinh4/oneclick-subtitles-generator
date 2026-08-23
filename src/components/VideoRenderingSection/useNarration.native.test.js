import { renderHook } from '@testing-library/react';

import {
  generateAlignedNarration,
  getAlignedNarrationArtifactIdForPlan,
  getAlignedNarrationUrlForPlan,
} from '../../services/alignedNarrationService.js';
import {
  requireGeneratedNarrationArtifact,
  useNarration,
} from './useNarration';

vi.mock('../../services/alignedNarrationService.js', () => ({
  generateAlignedNarration: vi.fn(),
  getAlignedNarrationArtifactIdForPlan: vi.fn(),
  getAlignedNarrationUrlForPlan: vi.fn(),
  resetAlignedNarration: vi.fn(),
}));

const narrationState = vi.hoisted(() => ({
  current: {
    activeSource: 'original',
    groupedCues: null,
    resultsBySource: { original: [], translated: [], grouped: [] },
  },
}));
vi.mock('../../platform/projectNarrationState', () => ({
  useProjectNarrationState: () => narrationState.current,
}));

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';
const nativeResult = {
  subtitle_id: 7,
  success: true,
  nativeArtifactId: ARTIFACT_ID,
  text: 'Current words',
  projectId: PROJECT_ID,
};
const currentCues = [{ id: 7, text: 'Current words', start: 0, end: 1 }];

const renderNarration = (overrides = {}) => renderHook(() => useNarration({
  selectedNarration: 'generated',
  narrationResults: [nativeResult],
  subtitlesData: currentCues,
  translatedSubtitles: [],
  selectedSubtitles: 'original',
  ...overrides,
}));

describe('render narration native plan ownership', () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    narrationState.current = {
      activeSource: 'original',
      groupedCues: null,
      resultsBySource: { original: [], translated: [], grouped: [] },
    };
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    delete window.alignedNarrationCache;
    global.fetch = originalFetch;
  });

  test('ignores a stale cache and resolves playback for the exact current plan', async () => {
    getAlignedNarrationArtifactIdForPlan
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(ARTIFACT_ID);
    getAlignedNarrationUrlForPlan
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('http://127.0.0.1:43111/asset/native?token=scoped');
    generateAlignedNarration.mockResolvedValue('aligned-preview://timeline');
    const { result } = renderNarration();

    await expect(result.current.getNarrationAudioUrl())
      .resolves.toBe('http://127.0.0.1:43111/asset/native?token=scoped');
    expect(generateAlignedNarration).toHaveBeenCalledWith([nativeResult], currentCues);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns only an artifact and playback matched to the current plan', async () => {
    getAlignedNarrationArtifactIdForPlan.mockReturnValue(ARTIFACT_ID);
    getAlignedNarrationUrlForPlan.mockReturnValue('http://127.0.0.1:43111/asset/current');
    const { result } = renderNarration();

    await expect(result.current.getNarrationArtifactId()).resolves.toBe(ARTIFACT_ID);
    expect(generateAlignedNarration).not.toHaveBeenCalled();
  });

  test.each([
    new Error('alignment failed'),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  ])('propagates %s instead of silently rendering without narration', async (failure) => {
    getAlignedNarrationArtifactIdForPlan.mockReturnValue(null);
    getAlignedNarrationUrlForPlan.mockReturnValue(null);
    generateAlignedNarration.mockRejectedValue(failure);
    const { result } = renderNarration();

    await expect(result.current.getNarrationArtifactId()).rejects.toBe(failure);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('uses the selected translated result set rather than a stale original bucket', async () => {
    narrationState.current = {
      activeSource: 'translated',
      groupedCues: null,
      resultsBySource: {
        original: [{ ...nativeResult, text: 'stale original' }],
        translated: [nativeResult],
        grouped: [],
      },
    };
    getAlignedNarrationArtifactIdForPlan.mockReturnValue(ARTIFACT_ID);
    getAlignedNarrationUrlForPlan.mockReturnValue('http://127.0.0.1:43111/asset/current');
    const { result } = renderNarration({
      narrationResults: [],
      subtitlesData: [{ ...currentCues[0], text: 'stale original' }],
      translatedSubtitles: currentCues,
      selectedSubtitles: 'translated',
    });

    await expect(result.current.getNarrationArtifactId()).resolves.toBe(ARTIFACT_ID);
  });

  test('generated selection refuses a missing aligned artifact while none stays silent', () => {
    expect(() => requireGeneratedNarrationArtifact('generated', null)).toThrow(
      expect.objectContaining({ code: 'narrationArtifactUnavailable' }),
    );
    expect(requireGeneratedNarrationArtifact('none', null)).toBeNull();
  });
});
