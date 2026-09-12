import { plannedNarrationResults } from './plannedNarrationResults';
import { deriveSubtitleId } from '../../../utils/subtitle/idUtils';

it('keeps plan order when parallel results arrive out of order', () => {
  const first = { subtitle_id: '1', success: true, filename: 'first.wav' };
  const third = { subtitle_id: 3, success: false, error: 'generation failed' };
  const removed = { subtitle_id: 4, success: true, filename: 'removed.wav' };
  const plan = [
    { id: 3, text: 'Third', start: 4, end: 6 },
    { id: 2, text: 'Second', start: 2, end: 4, original_ids: ['source-2'] },
    { id: 1, text: 'First', start: 0, end: 2 },
  ];

  const rows = plannedNarrationResults(plan, [first, removed, third]);

  expect(rows).toHaveLength(3);
  expect(rows[0]).toBe(third);
  expect(rows[1]).toEqual({
    subtitle_id: 2,
    text: 'Second',
    success: false,
    pending: true,
    start: 2,
    end: 4,
    original_ids: ['source-2'],
  });
  expect(rows[2]).toBe(first);
});

it('preserves the first matching result for duplicate numeric and string IDs', () => {
  const first = { subtitle_id: 0, text: 'First arrival', success: false };
  const duplicate = { subtitle_id: '0', text: 'Second arrival', success: true };

  expect(plannedNarrationResults([{ id: '0' }, { id: 0 }], [first, duplicate]))
    .toEqual([first, first]);
  expect(plannedNarrationResults([{ id: 0 }], [duplicate, first])[0]).toBe(duplicate);
});

it('uses the same derived identities for grouped cues and cues without explicit IDs', () => {
  const grouped = { text: 'Grouped', original_ids: [7, 8] };
  const cue = { text: 'No explicit ID', start: 1, end: 2 };
  const groupedResult = { subtitle_id: deriveSubtitleId(grouped), success: true };
  const cueResult = { subtitle_id: deriveSubtitleId(cue), success: true };

  expect(plannedNarrationResults([grouped, cue], [cueResult, groupedResult]))
    .toEqual([groupedResult, cueResult]);
});

it('shows pending planned rows before any result arrives and none for an empty plan', () => {
  const plan = [{ id: 'cue-1', text: 'Waiting', start: 0, end: 2 }];
  expect(plannedNarrationResults(plan, null)[0]).toMatchObject({
    subtitle_id: 'cue-1', text: 'Waiting', pending: true, success: false,
  });
  expect(plannedNarrationResults([], [{ subtitle_id: 'old-cue' }])).toEqual([]);
});
