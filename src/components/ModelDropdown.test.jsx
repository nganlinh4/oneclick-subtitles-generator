import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import ModelDropdown from './ModelDropdown';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (_key, fallback, values) => fallback.replace('{{count}}', values?.count ?? ''),
}) }));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const Picker = (props) => {
  const [value, setValue] = useState('gemini-3.1-flash-lite');
  return <ModelDropdown selectedModel={value} onModelSelect={setValue} {...props} />;
};

test.each([true, false])('shared model picker has compact quotas, sorted names, and preserves selection (translation=%s)', (isTranslationSection) => {
  const { container } = render(<Picker isTranslationSection={isTranslationSection} />);
  const button = screen.getByRole('button', { name: 'Select model' });
  expect(button).toHaveTextContent('Gemini 3.1 Flash Lite');
  fireEvent.click(button);
  expect(screen.getAllByRole('option').map(node => node.querySelector('.dropdown-option-label').textContent)).toEqual([
    'Gemini 3.8 Flash', 'Gemini 3.7 Flash', 'Gemini 3.6 Flash',
    'Gemini 3.5 Flash', 'Gemini 3.5 Flash Lite', 'Gemini 3.1 Flash Lite',
    'Gemini 3 Flash Preview', 'Gemini Robotics-ER 2 Preview',
  ]);
  expect(screen.getAllByRole('option').map(node => node.querySelector('.dropdown-option-detail').textContent))
    .toEqual([
      '20 requests/day', '20 requests/day', '20 requests/day', '20 requests/day',
      '500 requests/day', '500 requests/day', '20 requests/day', '20 requests/day',
    ]);
  expect(button).not.toHaveTextContent('requests/day');
  expect(container.querySelector('.custom-dropdown')).not.toBeNull();
  expect(document.querySelector('.model-options-dropdown')).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: 'Gemini 3.8 Flash 20 requests/day' }));
  act(() => vi.runAllTimers());
  expect(button).toHaveTextContent('Gemini 3.8 Flash');
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('a saved custom model appears without remounting and retains its explicit name', () => {
  render(<Picker />);
  act(() => {
    localStorage.setItem('custom_gemini_models', JSON.stringify([{ id: 'gemini-3.10-flash', name: 'My model' }]));
    window.dispatchEvent(new Event('storage'));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Select model' }));
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('My model (Custom)');
  expect(screen.getAllByRole('option')[0].querySelector('.dropdown-option-detail')).toHaveTextContent('—');
  fireEvent.click(screen.getByRole('option', { name: 'My model (Custom) —' }));
  act(() => vi.runAllTimers());
  expect(screen.getByRole('button', { name: 'Select model' })).toHaveTextContent('My model (Custom)');
});

test('a disabled picker cannot open during generation', () => {
  render(<Picker disabled />);
  const button = screen.getByRole('button', { name: 'Select model' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(screen.queryByRole('listbox')).toBeNull();
});
