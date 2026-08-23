import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { editNativeNarration } from '../../platform/nativeNarrationArtifacts';
import { commitNativeNarrationEdits } from '../../platform/nativeNarrationEditCommit';
import NarrationLaneControls from './NarrationLaneControls';

vi.mock('../../platform/nativeNarrationArtifacts', () => ({
  editNativeNarration: vi.fn(),
}));
vi.mock('../../platform/nativeNarrationEditCommit', () => ({
  commitNativeNarrationEdits: vi.fn(),
}));

const narrationState = vi.hoisted(() => ({ results: [] }));
const requestAlignedNarrationReset = vi.hoisted(() => vi.fn());
vi.mock('../../platform/projectNarrationState', () => ({
  getAllCurrentProjectNarrationResults: () => narrationState.results,
}));
vi.mock('../../platform/alignedNarrationSession', () => ({
  requestAlignedNarrationReset,
}));

vi.mock('../common/LiquidGlass', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

vi.mock('../common/StandardSlider', () => ({
  default: () => <div />,
}));

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const EDITED_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const filename = `osg-speech-artifact:${ARTIFACT_ID}`;
const narration = {
  subtitle_id: 7,
  success: true,
  filename,
  nativeArtifactId: ARTIFACT_ID,
  durationMicros: 2_000_000,
};
const replacement = {
  ...narration,
  filename: `osg-speech-artifact:${EDITED_ID}`,
  nativeArtifactId: EDITED_ID,
  durationMicros: 1_500_000,
};

const renderControls = () => render(<NarrationLaneControls
  narrationSegments={[{ id: 7, filename, start: 0, audioDuration: 2 }]}
  lyrics={[{ id: 7, start: 0, end: 3, text: 'hello' }]}
/>);

describe('native narration lane artifact edits', () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    window.isTauri = true;
    narrationState.results = [narration];
    originalFetch = global.fetch;
    global.fetch = vi.fn();
    commitNativeNarrationEdits.mockResolvedValue([replacement]);
  });

  afterEach(() => {
    delete window.isTauri;
    global.fetch = originalFetch;
  });

  test('edits the immutable artifact and publishes its replacement', async () => {
    editNativeNarration.mockResolvedValue(replacement);
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: /auto arrange/i }));

    await waitFor(() => expect(editNativeNarration).toHaveBeenCalledWith(narration, {
      normalizedStart: 0,
      normalizedEnd: 1,
      speedFactor: expect.any(Number),
    }));
    expect(commitNativeNarrationEdits).toHaveBeenCalledWith([{
      previous: narration,
      replacement,
    }]);
    expect(requestAlignedNarrationReset).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    new Error('edit failed'),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  ])('does not publish or refresh after %s', async (failure) => {
    editNativeNarration.mockRejectedValue(failure);
    const refreshed = vi.fn();
    window.addEventListener('request-narration-refresh', refreshed);
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: /auto arrange/i }));

    await waitFor(() => expect(editNativeNarration).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /auto arrange/i })).toBeEnabled());
    expect(commitNativeNarrationEdits).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
    expect(requestAlignedNarrationReset).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    window.removeEventListener('request-narration-refresh', refreshed);
  });

  test('does not refresh playback when the edited artifact cannot be saved', async () => {
    editNativeNarration.mockResolvedValue(replacement);
    commitNativeNarrationEdits.mockRejectedValue(new Error('sqlite unavailable'));
    const refreshed = vi.fn();
    window.addEventListener('request-narration-refresh', refreshed);
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: /auto arrange/i }));

    await waitFor(() => expect(commitNativeNarrationEdits).toHaveBeenCalledWith([{
      previous: narration,
      replacement,
    }]));
    await waitFor(() => expect(screen.getByRole('button', { name: /auto arrange/i })).toBeEnabled());
    expect(refreshed).not.toHaveBeenCalled();
    expect(requestAlignedNarrationReset).not.toHaveBeenCalled();
    window.removeEventListener('request-narration-refresh', refreshed);
  });
});
