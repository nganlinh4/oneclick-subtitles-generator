import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import PromptsTab from './PromptsTab';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('../../common/CustomScrollbarTextarea', async () => {
  const React = await import('react');
  return {
    default: React.forwardRef(function TestTextarea(props, ref) {
      return <textarea {...props} ref={ref} />;
    }),
  };
});

const TOKEN = '{contentType}';

const PromptHarness = ({ initialPrompt }) => {
  const [prompt, setPrompt] = useState(initialPrompt);
  return (
    <>
      <PromptsTab
        transcriptionPrompt={prompt}
        setTranscriptionPrompt={setPrompt}
      />
      <output data-testid="prompt-state">{prompt}</output>
    </>
  );
};

const typeOneCharacterAtATime = (textarea, text) => {
  for (const character of text) {
    const value = `${textarea.value}${character}`;
    fireEvent.change(textarea, {
      target: { value, selectionStart: value.length, selectionEnd: value.length },
    });
  }
};

beforeEach(() => {
  localStorage.clear();
});

it('allows clear-and-retype editing without injecting or duplicating the token', () => {
  render(<PromptHarness initialPrompt={`Old ${TOKEN} prompt`} />);
  const textarea = document.getElementById('transcription-prompt');
  const replacement = `New ordinary prompt for this ${TOKEN}.`;

  fireEvent.change(textarea, {
    target: { value: '', selectionStart: 0, selectionEnd: 0 },
  });
  expect(textarea).toHaveValue('');

  typeOneCharacterAtATime(textarea, replacement);
  expect(textarea).toHaveValue(replacement);

  fireEvent.blur(textarea);
  expect(screen.getByTestId('prompt-state')).toHaveTextContent(replacement);
  expect(textarea.value.split(TOKEN)).toHaveLength(2);
});

it('keeps an invalid draft editable and restores one token only on blur', () => {
  render(<PromptHarness initialPrompt={`Old ${TOKEN} prompt`} />);
  const textarea = document.getElementById('transcription-prompt');

  fireEvent.change(textarea, {
    target: { value: 'Keep this rewritten instruction', selectionStart: 29, selectionEnd: 29 },
  });
  expect(textarea).toHaveValue('Keep this rewritten instruction');

  fireEvent.blur(textarea);
  expect(textarea).toHaveValue(`Keep this rewritten instruction\n\n${TOKEN}`);
  expect(textarea.value.split(TOKEN)).toHaveLength(2);
});

it('restores the last complete prompt when an empty draft loses focus', () => {
  const lastValid = `A deliberately customized ${TOKEN} prompt`;
  render(<PromptHarness initialPrompt={lastValid} />);
  const textarea = document.getElementById('transcription-prompt');

  fireEvent.change(textarea, { target: { value: '' } });
  expect(textarea).toHaveValue('');
  fireEvent.blur(textarea);

  expect(textarea).toHaveValue(lastValid);
});
