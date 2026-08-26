import { renderHook, waitFor } from '@testing-library/react';

import useWindowStateManager from './useWindowStateManager';

const projectMocks = vi.hoisted(() => ({
  getActiveProjectSnapshot: vi.fn(),
}));
const groupingMocks = vi.hoisted(() => ({
  loadProjectSubtitleGrouping: vi.fn(),
}));
const narrationMocks = vi.hoisted(() => ({
  publishProjectNarrationGrouping: vi.fn(),
  publishProjectNarrationResults: vi.fn(),
}));

vi.mock('../../../platform/projectService', () => ({
  getActiveProjectSnapshot: projectMocks.getActiveProjectSnapshot,
}));
vi.mock('../../../platform/projectSubtitleGroupingStore', () => ({
  loadProjectSubtitleGrouping: groupingMocks.loadProjectSubtitleGrouping,
}));
vi.mock('../../../platform/projectNarrationState', () => ({
  publishProjectNarrationGrouping: narrationMocks.publishProjectNarrationGrouping,
  publishProjectNarrationResults: narrationMocks.publishProjectNarrationResults,
}));
vi.mock('../../../utils/narrationEnhancer', () => ({
  enhanceF5TTSNarrations: (results) => results,
}));

beforeEach(() => {
  vi.clearAllMocks();
  projectMocks.getActiveProjectSnapshot.mockReturnValue({
    metadata: { id: '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4' },
    stateVersion: 7,
  });
  groupingMocks.loadProjectSubtitleGrouping.mockResolvedValue(null);
});

test('a source-radio change cannot relabel the visible narration results', async () => {
  const originalResult = { subtitle_id: 1, text: 'hello', success: true };

  renderHook(() => useWindowStateManager({
    generationResults: [originalResult],
    generationResultSource: 'original',
    subtitleSource: 'translated',
    narrationMethod: 'gtts',
    originalSubtitles: [{ id: 1, text: 'hello', start: 0, end: 1 }],
    translatedSubtitles: [{ id: 1, text: 'bonjour', start: 0, end: 1 }],
    subtitles: [],
    useGroupedSubtitles: false,
    groupedSubtitles: null,
    setGroupedSubtitles: vi.fn(),
    setUseGroupedSubtitles: vi.fn(),
    groupingIntensity: 'balanced',
  }));

  await waitFor(() => expect(narrationMocks.publishProjectNarrationResults).toHaveBeenCalled());
  expect(narrationMocks.publishProjectNarrationResults).toHaveBeenCalledWith({
    projectId: '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4',
    projectStateVersion: 7,
    source: 'original',
    results: [originalResult],
    activate: false,
  });
  expect(narrationMocks.publishProjectNarrationResults).not.toHaveBeenCalledWith(
    expect.objectContaining({ source: 'translated', results: [originalResult] }),
  );
});

test('a blank editor draft clears stale grouping without reporting invalid provider data', async () => {
  const setGroupedSubtitles = vi.fn();
  const setUseGroupedSubtitles = vi.fn();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    renderHook(() => useWindowStateManager({
      generationResults: [],
      generationResultSource: 'original',
      subtitleSource: 'original',
      narrationMethod: 'gtts',
      originalSubtitles: [{ id: 1, text: '', start: 0, end: 2 }],
      translatedSubtitles: [],
      subtitles: [],
      useGroupedSubtitles: true,
      groupedSubtitles: [{ id: 1, text: 'stale', start: 0, end: 2 }],
      setGroupedSubtitles,
      setUseGroupedSubtitles,
      groupingIntensity: 'balanced',
    }));

    await waitFor(() => expect(setGroupedSubtitles).toHaveBeenCalledWith(null));
    expect(setUseGroupedSubtitles).toHaveBeenCalledWith(false);
    expect(groupingMocks.loadProjectSubtitleGrouping).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});
