import { loadPersistedLanguageChain } from './useLanguageChain';

it('hydrates only a bounded, strict, well-formed language chain', () => {
  const valid = JSON.stringify([
    { id: 1, type: 'language', value: 'English', isOriginal: false },
    { id: 2, type: 'delimiter', value: ' / ', style: { open: '[', close: ']' } },
    { id: 3, type: 'language', value: 'Original', isOriginal: true },
  ]);
  expect(loadPersistedLanguageChain(valid)).toEqual(JSON.parse(valid));

  for (const malformed of [
    '{',
    JSON.stringify([{ id: 1, type: 'language', value: '\ud800', isOriginal: false }]),
    JSON.stringify([{ id: 1, type: 'language', value: 'English', isOriginal: 'false' }]),
    JSON.stringify([{ id: 1, type: 'language', value: 'English', isOriginal: false, getter: true }]),
    ' '.repeat(17 * 1024),
  ]) {
    const fallback = loadPersistedLanguageChain(malformed);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ type: 'language', value: '', isOriginal: false });
  }
});

it('migrates a valid chain by adding one canonical original item without mutation', () => {
  const serialized = JSON.stringify([
    { id: 1, type: 'language', value: 'English', isOriginal: false },
  ]);
  const result = loadPersistedLanguageChain(serialized, true);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ type: 'language', value: 'Original', isOriginal: true });
  expect(JSON.parse(serialized)).toHaveLength(1);
});
