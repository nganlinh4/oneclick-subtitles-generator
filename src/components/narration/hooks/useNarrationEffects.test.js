import { renderHook } from '@testing-library/react';

import { showInfoToast } from '../../../utils/toastUtils';
import useNarrationEffects from './useNarrationEffects';

vi.mock('../../../utils/toastUtils', () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));
test('narration progress replaces one keyed toast instead of stacking per cue', () => {
  const base = {
    narrationMethod: 'gtts',
    setGenerationStatus: vi.fn(),
    setError: vi.fn(),
    sectionRef: { current: null },
    error: '',
    isGenerating: true,
    retryingSubtitleId: null,
  };
  const { rerender } = renderHook(
    (properties) => useNarrationEffects(properties),
    { initialProps: { ...base, generationStatus: 'Generating narration 1 of 3...' } },
  );

  rerender({ ...base, generationStatus: 'Generating narration 2 of 3...' });

  expect(showInfoToast).toHaveBeenNthCalledWith(
    1,
    'Generating narration 1 of 3...',
    12000,
    'narration-generation-progress',
  );
  expect(showInfoToast).toHaveBeenNthCalledWith(
    2,
    'Generating narration 2 of 3...',
    12000,
    'narration-generation-progress',
  );
});

test('localized narration progress does not depend on English message parsing', () => {
  renderHook(() => useNarrationEffects({
    narrationMethod: 'gtts',
    setGenerationStatus: vi.fn(),
    setError: vi.fn(),
    sectionRef: { current: null },
    error: '',
    isGenerating: true,
    retryingSubtitleId: null,
    generationStatus: 'Đã tạo 2 trên 5 thuyết minh...',
  }));

  expect(showInfoToast).toHaveBeenCalledWith(
    'Đã tạo 2 trên 5 thuyết minh...',
    12000,
    'narration-generation-progress',
  );
});
