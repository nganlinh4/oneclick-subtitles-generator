import {
  processTranslationResponse,
  TranslationResponseError,
} from './translationResponseParser';

const context = Object.freeze({
  languageIds: Object.freeze(['ko', 'vi']),
  sourceRows: Object.freeze([
    Object.freeze({ sourceId: 'string:cue-a', text: 'Hello' }),
    Object.freeze({ sourceId: 'string:cue-b', text: 'World' }),
  ]),
});

const validEnvelope = () => ({
  schemaVersion: 2,
  rows: [
    { ordinal: 0, translations: ['안녕하세요', 'Xin chào'] },
    { ordinal: 1, translations: ['세계', 'Thế giới'] },
  ],
});

const response = (value) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
});

it('accepts only the exact ordered source-language matrix', () => {
  expect(processTranslationResponse(response(validEnvelope()), context)).toEqual({
    schemaVersion: 2,
    languageIds: ['ko', 'vi'],
    rows: [
      {
        sourceId: 'string:cue-a',
        translations: [
          { languageId: 'ko', text: '안녕하세요' },
          { languageId: 'vi', text: 'Xin chào' },
        ],
      },
      {
        sourceId: 'string:cue-b',
        translations: [
          { languageId: 'ko', text: '세계' },
          { languageId: 'vi', text: 'Thế giới' },
        ],
      },
    ],
  });
});

it.each([
  ['wrong schema version', (value) => { value.schemaVersion = 1; }],
  ['unknown envelope property', (value) => { value.language = 'vi'; }],
  ['missing target translation', (value) => { value.rows[0].translations.pop(); }],
  ['extra target translation', (value) => { value.rows[0].translations.push('extra'); }],
  ['empty provider text', (value) => { value.rows[0].translations[0] = '   '; }],
  ['missing source row', (value) => { value.rows.pop(); }],
  ['duplicate source row', (value) => { value.rows[1] = { ...value.rows[0] }; }],
  ['reordered source rows', (value) => { value.rows.reverse(); }],
  ['non-integer source order', (value) => { value.rows[0].ordinal = '0'; }],
  ['non-array translations', (value) => { value.rows[0].translations = '안녕하세요'; }],
  ['unknown property', (value) => { value.rows[0].confidence = 1; }],
])('rejects %s instead of turning it into a complete translation', (_label, mutate) => {
  const envelope = validEnvelope();
  mutate(envelope);
  expect(() => processTranslationResponse(response(envelope), context)).toThrow(
    TranslationResponseError
  );
});

it('rejects legacy arrays and line-oriented text because neither carries row identity', () => {
  expect(() => processTranslationResponse(response([
    { original: 'Hello', translated: '안녕하세요' },
  ]), context)).toThrow(TranslationResponseError);
  expect(() => processTranslationResponse({
    candidates: [{ content: { parts: [{ text: '안녕하세요\n세계' }] } }],
  }, context)).toThrow(TranslationResponseError);
});
