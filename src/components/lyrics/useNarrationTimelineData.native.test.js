import { renderHook, waitFor } from '@testing-library/react';

import useNarrationTimelineData from './useNarrationTimelineData';

const narrationState = vi.hoisted(() => ({
  current: {
    activeSource: 'original',
    resultsBySource: { original: [], translated: [], grouped: [] },
  },
}));
vi.mock('../../platform/projectNarrationState', () => ({
  useProjectNarrationState: () => narrationState.current,
}));

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const filename = `osg-speech-artifact:${ARTIFACT_ID}`;

describe('native narration timeline durations', () => {
  let originalFetch;

  beforeEach(() => {
    window.isTauri = true;
    originalFetch = global.fetch;
    global.fetch = vi.fn();
    narrationState.current = {
      activeSource: 'original',
      resultsBySource: { original: [{
      subtitle_id: 7,
      success: true,
      filename,
      nativeArtifactId: ARTIFACT_ID,
      durationMicros: 2_500_000,
      }], translated: [], grouped: [] },
    };
  });

  afterEach(() => {
    delete window.isTauri;
    global.fetch = originalFetch;
  });

  test('derives natural duration from authenticated artifact metadata without HTTP', async () => {
    const { result } = renderHook(() => useNarrationTimelineData([
      { id: 7, start: 4, end: 6, text: 'hello' },
    ]));

    await waitFor(() => expect(result.current.segments).toEqual([{
      id: 7,
      filename,
      start: 4,
      audioDuration: 2.5,
    }]));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([null, 0, -1, Number.NaN])(
    'fails closed for invalid duration metadata %s',
    async (durationMicros) => {
      narrationState.current.resultsBySource.original[0].durationMicros = durationMicros;
      const { result } = renderHook(() => useNarrationTimelineData([
        { id: 7, start: 4, end: 6, text: 'hello' },
      ]));

      await waitFor(() => expect(result.current.segments).toEqual([]));
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );
});
