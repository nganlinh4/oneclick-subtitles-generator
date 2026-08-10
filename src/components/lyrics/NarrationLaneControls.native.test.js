import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { editNativeNarration } from '../../platform/nativeNarrationArtifacts';
import NarrationLaneControls from './NarrationLaneControls';

vi.mock('../../platform/nativeNarrationArtifacts', () => ({
  editNativeNarration: vi.fn(),
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
    window.originalNarrations = [narration];
    window.translatedNarrations = [];
    window.groupedNarrations = [];
    window.resetAlignedNarration = vi.fn();
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    delete window.isTauri;
    delete window.originalNarrations;
    delete window.translatedNarrations;
    delete window.groupedNarrations;
    delete window.resetAlignedNarration;
    global.fetch = originalFetch;
  });

  test('edits the immutable artifact and publishes its replacement', async () => {
    editNativeNarration.mockResolvedValue(replacement);
    const edited = vi.fn();
    window.addEventListener('native-narration-artifact-edited', edited);
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: /auto arrange/i }));

    await waitFor(() => expect(editNativeNarration).toHaveBeenCalledWith(narration, {
      normalizedStart: 0,
      normalizedEnd: 1,
      speedFactor: expect.any(Number),
    }));
    expect(edited).toHaveBeenCalledWith(expect.objectContaining({
      detail: { previousArtifactId: ARTIFACT_ID, result: replacement },
    }));
    expect(window.resetAlignedNarration).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    window.removeEventListener('native-narration-artifact-edited', edited);
  });

  test.each([
    new Error('edit failed'),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  ])('does not publish or refresh after %s', async (failure) => {
    editNativeNarration.mockRejectedValue(failure);
    const edited = vi.fn();
    const refreshed = vi.fn();
    window.addEventListener('native-narration-artifact-edited', edited);
    window.addEventListener('request-narration-refresh', refreshed);
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: /auto arrange/i }));

    await waitFor(() => expect(editNativeNarration).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /auto arrange/i })).toBeEnabled());
    expect(edited).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
    expect(window.resetAlignedNarration).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    window.removeEventListener('native-narration-artifact-edited', edited);
    window.removeEventListener('request-narration-refresh', refreshed);
  });
});
