import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import ModelDropdown from '../../ModelDropdown';
import CustomGeminiModelsCard from './CustomGeminiModelsCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

const Host = ({ onModelSelect = () => {}, initialModels = [] }) => {
  const [models, setModels] = useState(initialModels);
  return <>
    <CustomGeminiModelsCard
      customGeminiModels={models}
      setCustomGeminiModels={setModels}
    />
    <ModelDropdown
      isTranslationSection
      selectedModel="gemini-3.1-flash-lite"
      onModelSelect={onModelSelect}
    />
  </>;
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  window.addToast = vi.fn();
});

it('adds, persists, displays, and selects a future Gemini model as custom text', () => {
  const onModelSelect = vi.fn();
  render(<Host onModelSelect={onModelSelect} />);

  fireEvent.click(screen.getByRole('button', { name: /Add Custom Model/ }));
  fireEvent.change(screen.getByLabelText('Model ID *'), {
    target: { value: '  gemini-custom-test  ' },
  });
  fireEvent.change(screen.getByLabelText('Display Name'), {
    target: { value: 'Custom test model' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));

  expect(JSON.parse(localStorage.getItem('custom_gemini_models'))).toEqual([{
    id: 'gemini-custom-test',
    name: 'Custom test model',
    isCustom: true,
  }]);

  fireEvent.click(screen.getByTitle('Select model'));
  fireEvent.click(screen.getByRole('menuitem', { name: /Custom test model \(Custom\)/ }));
  expect(onModelSelect).toHaveBeenCalledOnce();
  expect(onModelSelect).toHaveBeenCalledWith('gemini-custom-test');
});

it('rejects a provider path instead of persisting it as a model ID', () => {
  render(<Host />);

  fireEvent.click(screen.getByRole('button', { name: /Add Custom Model/ }));
  fireEvent.change(screen.getByLabelText('Model ID *'), {
    target: { value: 'models/gemini-custom-test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));

  expect(window.addToast).toHaveBeenCalledWith(
    expect.stringMatching(/model id/i),
    'warning',
    7000
  );
  expect(localStorage.getItem('custom_gemini_models')).toBeNull();
});

it('confirms deletion without blocking and cannot erase a model added while confirmation waits', async () => {
  render(<Host initialModels={[{
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    isCustom: true,
  }]} />);

  fireEvent.click(screen.getByTitle('Delete model'));
  const confirmation = window.addToast.mock.calls.at(-1)[4];
  expect(screen.getByText('Gemini 3.7 Flash')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Add Custom Model/ }));
  fireEvent.change(screen.getByLabelText('Model ID *'), {
    target: { value: 'gemini-custom-test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));

  await act(async () => { await confirmation.onClick(); });

  expect(screen.queryByText('Gemini 3.7 Flash')).not.toBeInTheDocument();
  expect(screen.getAllByText('gemini-custom-test')).toHaveLength(2);
  expect(JSON.parse(localStorage.getItem('custom_gemini_models'))).toEqual([{
    id: 'gemini-custom-test',
    name: 'gemini-custom-test',
    isCustom: true,
  }]);
});
