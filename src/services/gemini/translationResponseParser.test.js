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
  schemaVersion: 1,
  translations: [
    {
      languageId: 'ko',
      rows: [
        { sourceId: 'string:cue-a', original: 'Hello', translated: '안녕하세요' },
        { sourceId: 'string:cue-b', original: 'World', translated: '세계' },
      ],
    },
    {
      languageId: 'vi',
      rows: [
        { sourceId: 'string:cue-a', original: 'Hello', translated: 'Xin chào' },
        { sourceId: 'string:cue-b', original: 'World', translated: 'Thế giới' },
      ],
    },
  ],
});

const response = (value) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
});

it('accepts only the exact ordered source-language matrix', () => {
  expect(processTranslationResponse(response(validEnvelope()), context)).toEqual({
    schemaVersion: 1,
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
  ['missing language', (value) => { value.translations.pop(); }],
  ['unknown language', (value) => { value.translations[1].languageId = 'Vietnamese'; }],
  ['duplicate language', (value) => { value.translations[1].languageId = 'ko'; }],
  ['reordered language', (value) => { value.translations.reverse(); }],
  ['empty provider text', (value) => { value.translations[0].rows[0].translated = '   '; }],
  ['missing source row', (value) => { value.translations[0].rows.pop(); }],
  ['duplicate source row', (value) => { value.translations[0].rows[1] = { ...value.translations[0].rows[0] }; }],
  ['reordered source rows', (value) => { value.translations[0].rows.reverse(); }],
  ['incorrect echoed original', (value) => { value.translations[0].rows[0].original = ' hello '; }],
  ['language-label substitution', (value) => { value.translations[0].rows[0].translated = ''; value.translations[0].rows[0].language = 'Korean'; }],
  ['unknown property', (value) => { value.translations[0].rows[0].confidence = 1; }],
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
