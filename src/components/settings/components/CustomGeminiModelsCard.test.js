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

it('keeps an added model in the settings draft until the form is saved', () => {
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

  expect(screen.getByText('Custom test model')).toBeInTheDocument();
  expect(localStorage.getItem('custom_gemini_models')).toBeNull();

  fireEvent.click(screen.getByTitle('Select model'));
  expect(screen.queryByRole('menuitem', { name: /Custom test model \(Custom\)/ })).not.toBeInTheDocument();
  expect(onModelSelect).not.toHaveBeenCalled();
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
  expect(localStorage.getItem('custom_gemini_models')).toBeNull();
});

it('does not publish a renamed model when the settings form is discarded', () => {
  const original = [{ id: 'gemini-custom-test', name: 'Saved model', isCustom: true }];
  localStorage.setItem('custom_gemini_models', JSON.stringify(original));
  const { unmount } = render(<Host initialModels={original} />);
  fireEvent.click(screen.getByTitle('Edit model'));
  fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Unsaved name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update Model' }));
  expect(screen.getByText('Unsaved name')).toBeInTheDocument();
  unmount();
  expect(JSON.parse(localStorage.getItem('custom_gemini_models'))).toEqual(original);
});
