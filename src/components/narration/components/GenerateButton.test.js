import { fireEvent, render, screen } from '@testing-library/react';
import GenerateButton from './GenerateButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

const baseProps = (overrides = {}) => ({
  handleGenerateNarration: vi.fn(),
  isGenerating: false,
  referenceAudio: null,
  generationResults: [],
  downloadAllAudio: vi.fn(),
  downloadAlignedAudio: vi.fn(),
  cancelGeneration: vi.fn(),
  subtitleSource: 'original',
  narrationMethod: 'edge-tts',
  ...overrides,
});

afterEach(() => vi.clearAllMocks());

const REFERENCE_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const RESULT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';

it('blocks generation for a method whose native runtime is not ready', () => {
  const props = baseProps({
    isServiceAvailable: false,
    serviceUnavailableMessage: 'Install or start this engine in Settings.',
  });
  render(<GenerateButton {...props} />);

  const generate = screen.getByRole('button', { name: /Generate Narration/u });
  expect(generate).toHaveAttribute('data-osg-action', 'generate-narration');
  expect(generate).toHaveAttribute('data-narration-method', 'edge-tts');
  expect(screen.getByRole('button', { name: /timeline/i }))
    .toHaveAttribute('data-osg-action', 'download-aligned-narration');
  expect(generate).toBeDisabled();
  expect(generate).toHaveAttribute('title', 'Install or start this engine in Settings.');
  fireEvent.click(generate);
  expect(props.handleGenerateNarration).not.toHaveBeenCalled();
});

it('allows generation after the native runtime has been proven ready', () => {
  const props = baseProps({ isServiceAvailable: true });
  render(<GenerateButton {...props} />);

  fireEvent.click(screen.getByRole('button', { name: /Generate Narration/u }));
  expect(props.handleGenerateNarration).toHaveBeenCalledTimes(1);
});

it.each(['f5tts', 'chatterbox'])(
  'accepts a nativeArtifactId-only descriptor as the authoritative %s reference',
  (narrationMethod) => {
    const props = baseProps({
      narrationMethod,
      isServiceAvailable: true,
      referenceAudio: { nativeArtifactId: REFERENCE_ID, text: 'reference words' },
    });
    render(<GenerateButton {...props} />);

    const generate = screen.getByRole('button', { name: /Generate Narration/u });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    expect(props.handleGenerateNarration).toHaveBeenCalledTimes(1);
  }
);

it.each(['f5tts', 'chatterbox'])(
  'rejects a browser URL without a native artifact for %s',
  (narrationMethod) => {
    const props = baseProps({
      narrationMethod,
      isServiceAvailable: true,
      referenceAudio: { url: 'blob:legacy-reference' },
    });
    render(<GenerateButton {...props} />);

    const generate = screen.getByRole('button', { name: /Generate Narration/u });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAttribute('title', expect.stringContaining('reference audio'));
    fireEvent.click(generate);
    expect(props.handleGenerateNarration).not.toHaveBeenCalled();
  }
);

it('shows the F5 language boundary reason and blocks generation', () => {
  const props = baseProps({
    narrationMethod: 'f5tts',
    isServiceAvailable: true,
    referenceAudio: { nativeArtifactId: REFERENCE_ID },
    generationBlockedReason: 'F5-TTS supports English and Chinese subtitles only.',
  });
  render(<GenerateButton {...props} />);

  const generate = screen.getByRole('button', { name: /Generate Narration/u });
  expect(generate).toBeDisabled();
  expect(generate).toHaveAttribute('title', props.generationBlockedReason);
});

it('offers aligned download only for a complete set of native artifact capabilities', () => {
  const { rerender } = render(<GenerateButton {...baseProps({
    generationResults: [{ subtitle_id: 1, success: true, filename: 'legacy.wav' }],
  })} />);
  expect(screen.getByRole('button', { name: /timeline/i })).toBeDisabled();

  rerender(<GenerateButton {...baseProps({
    generationResults: [{
      subtitle_id: 1,
      success: true,
      nativeArtifactId: RESULT_ID,
    }],
  })} />);
  expect(screen.getByRole('button', { name: /timeline/i })).toBeEnabled();

  rerender(<GenerateButton {...baseProps({
    generationResults: [
      { subtitle_id: 1, success: true, nativeArtifactId: RESULT_ID },
      { subtitle_id: 2, success: false },
    ],
  })} />);
  expect(screen.getByRole('button', { name: /timeline/i })).toBeDisabled();
});
