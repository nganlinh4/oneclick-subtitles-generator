import { act, renderHook } from '@testing-library/react';

import { editNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import useGeminiAudioSpeed from './useGeminiAudioSpeed';
import useNarrationAudioSpeed from './useNarrationAudioSpeed';

vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/nativeNarrationArtifacts', () => ({
  editNativeNarration: vi.fn(),
}));

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const EDITED_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const filename = `osg-speech-artifact:${ARTIFACT_ID}`;
const narration = {
  subtitle_id: 4,
  success: true,
  pending: false,
  nativeArtifactId: ARTIFACT_ID,
  nativeFormat: 'wav',
  durationMicros: 2_000_000,
  filename,
};
const edited = {
  ...narration,
  nativeArtifactId: EDITED_ID,
  durationMicros: 800_000,
  filename: `osg-speech-artifact:${EDITED_ID}`,
};

describe('native immutable narration speed edits', () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
    global.fetch = vi.fn();
    editNativeNarration.mockResolvedValue(edited);
    window.resetAlignedNarration = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete window.resetAlignedNarration;
  });

  test('the shared result hook derives duration metadata and edits one artifact natively', async () => {
    const editedEvent = vi.fn();
    window.addEventListener('native-narration-artifact-edited', editedEvent);
    const { result } = renderHook(() => useNarrationAudioSpeed({
      generationResults: [narration],
      t: (_key, fallback) => fallback,
    }));

    await act(async () => result.current.fetchDurationsBatch([filename]));
    expect(result.current.itemDurations[filename]).toBe(2);
    act(() => {
      result.current.setItemTrim(4, [0.5, 1.5]);
      result.current.setItemSpeed(4, 1.25);
    });
    await act(async () => result.current.modifySingleAudioEditCombined(narration));

    expect(editNativeNarration).toHaveBeenCalledWith(narration, {
      normalizedStart: 0.25,
      normalizedEnd: 0.75,
      speedFactor: 1.25,
    });
    expect(editedEvent).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    window.removeEventListener('native-narration-artifact-edited', editedEvent);
  });

  test('the Gemini result hook uses the same native artifact edit contract', async () => {
    const setters = {
      setItemSpeeds: vi.fn(),
      setItemDurations: vi.fn(),
      setItemProcessing: vi.fn(),
      setIsProcessing: vi.fn(),
      setProcessingProgress: vi.fn(),
      setCurrentFile: vi.fn(),
    };
    const { result } = renderHook(() => useGeminiAudioSpeed({
      generationResults: [narration],
      speedValue: 1.5,
      itemSpeeds: { 4: 1.5 },
      itemTrims: { 4: [0.5, 1.5] },
      itemDurations: { [filename]: 2 },
      ...setters,
      processedCountRef: { current: 0 },
      seenItemsRef: { current: new Set() },
      t: (_key, fallback) => fallback,
    }));

    await act(async () => result.current.modifySingleAudioEditCombined(narration));
    expect(editNativeNarration).toHaveBeenCalledWith(narration, {
      normalizedStart: 0.25,
      normalizedEnd: 0.75,
      speedFactor: 1.5,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
