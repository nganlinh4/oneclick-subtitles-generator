import { renderHook } from '@testing-library/react';

import { useAppEffects } from './AppEffects';
import { persistDesktopSettings } from '../../platform/settingsService';

vi.mock('../../platform/settingsService', () => ({
  persistDesktopSettings: vi.fn(),
}));
vi.mock('../../utils/geminiEffects', () => ({
  initGeminiButtonEffects: vi.fn(),
  resetAllGeminiButtonEffects: vi.fn(),
  disableGeminiButtonEffects: vi.fn(),
}));
vi.mock('../../utils/tabPillAnimation', () => ({ default: vi.fn() }));
vi.mock('../../utils/systemDetection', () => ({ getThemeWithFallback: () => 'dark' }));

const props = () => ({
  setSegmentsStatus: vi.fn(),
  setVideoSegments: vi.fn(),
  setTheme: vi.fn(),
  setShowWaveformLongVideos: vi.fn(),
  setTimeFormat: vi.fn(),
  setOptimizeVideos: vi.fn(),
  setOptimizedResolution: vi.fn(),
  setUseOptimizedPreview: vi.fn(),
  subtitlesData: [],
  status: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

it('never turns mount defaults or browser storage events into native preference writes', () => {
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('transcription_prompt', 'computed default, not user intent');
  const view = renderHook(() => useAppEffects(props()));

  window.dispatchEvent(new StorageEvent('storage', {
    key: 'gemini_model',
    newValue: 'gemini-3.1-flash-lite',
  }));

  expect(persistDesktopSettings).not.toHaveBeenCalled();
  view.unmount();
});
