import {
  assertTranslationTerminalMatchesSource,
  canonicalTranslationSourcePayload,
  fingerprintTranslationSource,
  normalizeLanguageChain,
  normalizeTranslationRecord,
  snapshotTranslationSource,
} from './translationOwnership';

const source = () => [
  { id: 'alpha', start: 0, end: 1.25, text: 'Hello' },
  { id: 'beta', start: 1.25, end: 2.5, text: 'World' },
];

it('uses SHA-256 over stable ID, order, start, end, and text', async () => {
  const baseline = await fingerprintTranslationSource(source());
  expect(baseline).toMatch(/^[a-f0-9]{64}$/);

  const variants = [
    source().map((row, index) => (index === 0 ? { ...row, start: 0.001 } : row)),
    source().map((row, index) => (index === 0 ? { ...row, end: 1.251 } : row)),
    [source()[1], source()[0]],
    source().map((row, index) => (index === 0 ? { ...row, id: 'changed' } : row)),
    source().map((row, index) => (index === 0 ? { ...row, text: 'hello' } : row)),
  ];
  for (const variant of variants) {
    await expect(fingerprintTranslationSource(variant)).resolves.not.toBe(baseline);
  }
});

it('snapshots immutable rows with canonical original IDs and no source references', () => {
  const rows = source();
  const snapshot = snapshotTranslationSource(rows);
  rows[0].text = 'mutated';
  expect(snapshot[0]).toMatchObject({ text: 'Hello', originalId: 'string:alpha', sourceOrder: 0 });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot[0])).toBe(true);
  expect(canonicalTranslationSourcePayload(snapshot)).toContain('string:alpha');
});

it('rejects accessors, non-plain rows, lone surrogates, and malformed timing', () => {
  const accessor = { id: 1, start: 0, end: 1 };
  Object.defineProperty(accessor, 'text', {
    enumerable: true,
    get() { throw new Error('must not execute'); },
  });
  expect(() => snapshotTranslationSource([accessor])).toThrowError(
    expect.objectContaining({ code: 'invalidTranslationData' })
  );
  expect(() => snapshotTranslationSource([
    Object.assign(Object.create(null), { id: 1, start: 0, end: 1, text: 'x' }),
  ])).toThrowError(expect.objectContaining({ code: 'invalidTranslationData' }));
  expect(() => snapshotTranslationSource([{ id: 1, start: 0, end: 1, text: '\ud800' }]))
    .toThrowError(expect.objectContaining({ code: 'invalidTranslationData' }));
  expect(() => snapshotTranslationSource([{ id: 1, start: 2, end: 1, text: 'x' }]))
    .toThrowError(expect.objectContaining({ code: 'invalidTranslationSource' }));
});

it('validates language-chain kinds, fields, bounds, Unicode, and accessors atomically', () => {
  const valid = normalizeLanguageChain([
    { id: 1, type: 'language', value: 'English', isOriginal: false },
    { id: 2, type: 'delimiter', value: ' / ', style: { open: '', close: '' } },
    { id: 3, type: 'language', value: 'Original', isOriginal: true },
  ]);
  expect(valid).toHaveLength(3);

  for (const invalid of [
    [{ id: 1, type: 'unknown', value: '' }],
    [{ id: 1, type: 'language', value: '\udfff', isOriginal: false }],
    [{ id: 1, type: 'language', value: 'Not original', isOriginal: true }],
    [{ id: 1, type: 'language', value: 'English', isOriginal: false, extra: true }],
  ]) {
    expect(() => normalizeLanguageChain(invalid)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^invalid/) })
    );
  }
  const accessor = { id: 1, type: 'language', isOriginal: false };
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'English' });
  expect(() => normalizeLanguageChain([accessor])).toThrowError(
    expect.objectContaining({ code: 'invalidTranslationData' })
  );
});

it('requires explicit partial metadata and keeps the base result immutable', () => {
  const record = normalizeTranslationRecord({
    schemaVersion: 1,
    revision: 1,
    sourceFingerprint: 'b'.repeat(64),
    sourceEntryCount: 3,
    languageChain: [{ id: 1, type: 'language', value: 'English', isOriginal: false }],
    model: 'gemini-test',
    status: 'partial',
    baseSubtitles: [{
      id: 1,
      start: 0,
      end: 1,
      text: 'Translated',
      originalId: 'number:1',
      sourceOrder: 0,
    }],
    failedChunks: [{ chunkIndex: 1, startOrder: 1, endOrder: 2, errorCode: 'providerFailed' }],
  });
  expect(record.status).toBe('partial');
  expect(Object.isFrozen(record.baseSubtitles)).toBe(true);
  expect(() => normalizeTranslationRecord({ ...record, status: 'complete' }))
    .toThrowError(expect.objectContaining({ code: 'invalidTranslationData' }));
});

it('rejects symbol fields, duplicate source IDs, sparse arrays, and invalid partial coverage', () => {
  const symbolRow = { id: 1, start: 0, end: 1, text: 'x' };
  Object.defineProperty(symbolRow, Symbol('hidden'), { value: true, enumerable: false });
  expect(() => snapshotTranslationSource([symbolRow])).toThrowError(
    expect.objectContaining({ code: 'invalidTranslationData' })
  );

  expect(() => snapshotTranslationSource([
    { id: 'same', start: 0, end: 1, text: 'a' },
    { id: 'same', start: 1, end: 2, text: 'b' },
  ])).toThrowError(expect.objectContaining({ code: 'invalidTranslationSource' }));

  const sparse = new Array(2);
  sparse[0] = { id: 1, start: 0, end: 1, text: 'a' };
  expect(() => snapshotTranslationSource(sparse)).toThrowError(
    expect.objectContaining({ code: 'invalidTranslationSource' })
  );

  const partial = {
    schemaVersion: 1,
    revision: 1,
    sourceFingerprint: 'c'.repeat(64),
    sourceEntryCount: 3,
    languageChain: [{ id: 1, type: 'language', value: 'English', isOriginal: false }],
    model: 'gemini-test',
    status: 'partial',
    baseSubtitles: [{
      id: 1,
      start: 0,
      end: 1,
      text: 'Translated',
      originalId: 'number:1',
      sourceOrder: 0,
    }],
    failedChunks: [{ chunkIndex: 1, startOrder: 2, endOrder: 3, errorCode: 'failed' }],
  };
  expect(() => normalizeTranslationRecord(partial)).toThrowError(
    expect.objectContaining({ code: 'invalidTranslationData' })
  );

  const overlapping = {
    ...partial,
    sourceEntryCount: 4,
    failedChunks: [
      { chunkIndex: 1, startOrder: 1, endOrder: 2, errorCode: 'firstFailure' },
      { chunkIndex: 2, startOrder: 2, endOrder: 3, errorCode: 'secondFailure' },
    ],
  };
  expect(() => normalizeTranslationRecord(overlapping)).toThrowError(
    expect.objectContaining({ code: 'invalidTranslationData' })
  );

  const symbolRecord = { ...partial, failedChunks: [{
    chunkIndex: 1,
    startOrder: 1,
    endOrder: 2,
    errorCode: 'failed',
  }] };
  Object.defineProperty(symbolRecord, Symbol('hidden'), { value: true });
  expect(() => normalizeTranslationRecord(symbolRecord)).toThrowError(
    expect.objectContaining({ code: 'invalidTranslationData' })
  );
});

it('rejects translation data beyond the aggregate UTF-8 budget', async () => {
  const oversizedText = 'é'.repeat(360 * 1024);
  await expect(fingerprintTranslationSource([{
    id: 1,
    start: 0,
    end: 1,
    text: oversizedText,
  }])).rejects.toMatchObject({ code: 'translationTooLarge' });

  expect(() => normalizeTranslationRecord({
    schemaVersion: 1,
    revision: 1,
    sourceFingerprint: 'd'.repeat(64),
    sourceEntryCount: 1,
    languageChain: [{ id: 1, type: 'language', value: 'English', isOriginal: false }],
    model: 'gemini-test',
    status: 'complete',
    baseSubtitles: [{
      id: 1,
      start: 0,
      end: 1,
      text: oversizedText,
      originalId: 'number:1',
      sourceOrder: 0,
    }],
    failedChunks: [],
  })).toThrowError(expect.objectContaining({ code: 'translationTooLarge' }));
});

it('rejects durable rows whose stable ID or timing does not match the captured source', () => {
  const terminal = {
    schemaVersion: 1,
    sourceFingerprint: 'e'.repeat(64),
    sourceEntryCount: 2,
    languageChain: [{ id: 1, type: 'language', value: 'English', isOriginal: false }],
    model: 'gemini-test',
    status: 'complete',
    baseSubtitles: [
      {
        id: 'alpha',
        start: 0,
        end: 1.25,
        text: 'Translated A',
        originalId: 'string:alpha',
        sourceOrder: 0,
      },
      {
        id: 'beta',
        start: 1.25,
        end: 2.5,
        text: 'Translated B',
        originalId: 'string:beta',
        sourceOrder: 1,
      },
    ],
    failedChunks: [],
  };
  expect(assertTranslationTerminalMatchesSource(terminal, source()).baseSubtitles)
    .toHaveLength(2);
  expect(() => assertTranslationTerminalMatchesSource({
    ...terminal,
    baseSubtitles: terminal.baseSubtitles.map((row, index) => (
      index === 0 ? { ...row, originalId: 'string:wrong' } : row
    )),
  }, source())).toThrowError(expect.objectContaining({ code: 'translationSourceMismatch' }));
  expect(() => assertTranslationTerminalMatchesSource({
    ...terminal,
    baseSubtitles: terminal.baseSubtitles.map((row, index) => (
      index === 1 ? { ...row, start: 1.5 } : row
    )),
  }, source())).toThrowError(expect.objectContaining({ code: 'translationSourceMismatch' }));
});
