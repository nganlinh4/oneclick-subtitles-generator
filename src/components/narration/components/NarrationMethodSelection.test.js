import { fireEvent, render } from '@testing-library/react';
import NarrationMethodSelection from './NarrationMethodSelection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../../common/HelpIcon', () => ({
  default: ({ title }) => <span title={title}>help</span>,
}));

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

const selectableMethodInputs = () => [
  'method-f5tts',
  'method-chatterbox',
  'method-gemini',
  'method-edge-tts',
  'method-gtts',
].map((id) => document.getElementById(id));

it('fails every real narration choice closed when availability has not been supplied', () => {
  render(
    <NarrationMethodSelection
      narrationMethod="gemini"
      setNarrationMethod={vi.fn()}
      isGenerating={false}
    />
  );

  selectableMethodInputs().forEach((input) => expect(input).toBeDisabled());
});

it('enables only methods proven ready and persists only a valid selection', () => {
  const setNarrationMethod = vi.fn();
  render(
    <NarrationMethodSelection
      narrationMethod="edge-tts"
      setNarrationMethod={setNarrationMethod}
      isGenerating={false}
      isF5Available={false}
      isChatterboxAvailable={false}
      isGeminiAvailable={false}
      isEdgeTTSAvailable={true}
      isGTTSAvailable={true}
    />
  );

  const [f5, chatterbox, gemini, edge, gtts] = selectableMethodInputs();
  expect(f5).toBeDisabled();
  expect(chatterbox).toBeDisabled();
  expect(gemini).toBeDisabled();
  expect(edge).toBeEnabled();
  expect(gtts).toBeEnabled();

  fireEvent.click(f5);
  expect(setNarrationMethod).not.toHaveBeenCalled();
  expect(localStorage.getItem('narration_method')).toBeNull();

  fireEvent.click(gtts);
  expect(setNarrationMethod).toHaveBeenCalledWith('gtts');
  expect(localStorage.getItem('narration_method')).toBe('gtts');
});
