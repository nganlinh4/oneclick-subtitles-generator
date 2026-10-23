import { fireEvent, render, within } from '@testing-library/react';
import TranscriptionRulesEditor from './TranscriptionRulesEditor';

const mocks = vi.hoisted(() => ({ interact: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key, fallback) => fallback }) }));
vi.mock('../services/geminiService', () => ({ PROMPT_PRESETS: [], getUserPromptPresets: () => [] }));
vi.mock('./transcriptionRules/PresetSelector', () => ({ default: () => null }));
vi.mock('./transcriptionRules/useCountdownTimer', () => ({
  default: () => ({ showCountdown: false, countdown: 0, handleUserInteraction: mocks.interact }),
}));

const rules = {
  atmosphere: 'a',
  terminology: [{ term: 't1', definition: 'd1' }],
  speakerIdentification: [{ speakerId: 's1', description: 'x1' }],
  formattingConventions: ['f1'],
  spellingAndGrammar: ['g1', 'g2'],
  relationships: ['r1'],
  additionalNotes: [],
};

const renderEditor = () => render(
  <TranscriptionRulesEditor isOpen initialRules={rules} onSave={vi.fn()} onClose={vi.fn()} />
);

const sectionByTitle = (container, title) => [...container.querySelectorAll('.rules-editor-section')]
  .find((section) => section.querySelector('h3')?.textContent === title);

test('renders the six list sections with their row shapes and add labels', () => {
  const { container } = renderEditor();
  const expected = [
    ['Terminology & Proper Nouns', 1, 'pair', '+ Add Term'],
    ['Speaker Identification', 1, 'pair', '+ Add Speaker'],
    ['Formatting & Style Conventions', 1, 'single', '+ Add Formatting Rule'],
    ['Spelling, Grammar & Punctuation', 2, 'single', '+ Add Spelling/Grammar Rule'],
    ['Relationships & Social Hierarchy', 1, 'single', '+ Add Relationship'],
    ['Additional Notes', 0, 'single', '+ Add Note'],
  ];
  expect(container.querySelectorAll('.rules-editor-section')).toHaveLength(7);
  for (const [title, rowCount, shape, addLabel] of expected) {
    const section = sectionByTitle(container, title);
    expect(section.querySelector('p.section-description')).not.toBeNull();
    const rows = section.querySelectorAll('.array-item-row');
    expect(rows).toHaveLength(rowCount);
    for (const row of rows) {
      if (shape === 'pair') {
        const inputs = row.querySelectorAll('.term-inputs > input');
        expect(inputs).toHaveLength(2);
        expect(inputs[0].className).toBe('');
        expect(inputs[1].className).toBe('definition-input');
      } else {
        expect(row.querySelector(':scope > input').className).toBe('full-width-input');
      }
      expect(row.querySelector('.remove-item-button .material-symbols-rounded').textContent).toBe('close');
    }
    expect(section.querySelector(':scope > .add-item-button').textContent).toBe(addLabel);
  }
});

test('add, edit and remove act on the section they belong to', () => {
  const { container } = renderEditor();
  const speakers = sectionByTitle(container, 'Speaker Identification');
  fireEvent.click(within(speakers).getByText('+ Add Speaker'));
  expect(speakers.querySelectorAll('.array-item-row')).toHaveLength(2);
  expect(speakers.querySelectorAll('.array-item-row')[1].querySelector('input').value).toBe('');

  const spelling = sectionByTitle(container, 'Spelling, Grammar & Punctuation');
  fireEvent.change(spelling.querySelectorAll('input')[1], { target: { value: 'g2 edited' } });
  expect(spelling.querySelectorAll('input')[1].value).toBe('g2 edited');
  fireEvent.click(spelling.querySelectorAll('.remove-item-button')[0]);
  expect([...spelling.querySelectorAll('input')].map((input) => input.value)).toEqual(['g2 edited']);
  expect(sectionByTitle(container, 'Relationships & Social Hierarchy')
    .querySelectorAll('.array-item-row')).toHaveLength(1);
});

test('focusing any list input counts as user interaction', () => {
  const { container } = renderEditor();
  mocks.interact.mockClear();
  fireEvent.focus(sectionByTitle(container, 'Speaker Identification').querySelector('input'));
  fireEvent.focus(sectionByTitle(container, 'Additional Notes').querySelector('.add-item-button'));
  fireEvent.focus(sectionByTitle(container, 'Relationships & Social Hierarchy').querySelector('input'));
  expect(mocks.interact).toHaveBeenCalledTimes(2);
});
