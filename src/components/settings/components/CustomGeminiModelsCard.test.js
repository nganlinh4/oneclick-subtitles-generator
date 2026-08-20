import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import ModelDropdown from '../../ModelDropdown';
import CustomGeminiModelsCard from './CustomGeminiModelsCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

const Host = ({ onModelSelect = () => {} }) => {
  const [models, setModels] = useState([]);
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
});

it('adds, persists, displays, and selects a future Gemini model as custom text', () => {
  const onModelSelect = vi.fn();
  render(<Host onModelSelect={onModelSelect} />);

  fireEvent.click(screen.getByRole('button', { name: /Add Custom Model/ }));
  fireEvent.change(screen.getByLabelText('Model ID *'), {
    target: { value: '  gemini-3.8-flash  ' },
  });
  fireEvent.change(screen.getByLabelText('Display Name'), {
    target: { value: 'Gemini 3.8 Flash' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));

  expect(JSON.parse(localStorage.getItem('custom_gemini_models'))).toEqual([{
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    isCustom: true,
  }]);

  fireEvent.click(screen.getByTitle('Select model'));
  fireEvent.click(screen.getByRole('menuitem', { name: /Gemini 3\.8 Flash \(Custom\)/ }));
  expect(onModelSelect).toHaveBeenCalledOnce();
  expect(onModelSelect).toHaveBeenCalledWith('gemini-3.8-flash');
});

it('rejects a provider path instead of persisting it as a model ID', () => {
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  render(<Host />);

  fireEvent.click(screen.getByRole('button', { name: /Add Custom Model/ }));
  fireEvent.change(screen.getByLabelText('Model ID *'), {
    target: { value: 'models/gemini-3.8-flash' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));

  expect(alert).toHaveBeenCalledOnce();
  expect(localStorage.getItem('custom_gemini_models')).toBeNull();
});
