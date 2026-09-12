import { createTranslationStreamObserver } from './translationStreamObserver';

const sourceRows = [
  { sourceId: 'a', text: 'Hello' },
  { sourceId: 'b', text: 'World' },
];

it('publishes complete rows across arbitrary structured-output chunk boundaries', () => {
  const published = [];
  const observer = createTranslationStreamObserver({
    languageIds: ['ko', 'vi'],
    sourceRows,
    onRows: (rows) => published.push(...rows),
  });
  const text = JSON.stringify({
    schemaVersion: 2,
    rows: [
      { ordinal: 0, translations: ['안녕 } \\"', 'Xin chào'] },
      { ordinal: 1, translations: ['세계', 'Thế giới'] },
    ],
  });
  for (let offset = 0; offset < text.length; offset += 3) {
    observer.feed(text.slice(offset, offset + 3));
  }
  expect(published).toEqual([
    {
      sourceId: 'a',
      translations: [
        { languageId: 'ko', text: '안녕 } \\"' },
        { languageId: 'vi', text: 'Xin chào' },
      ],
    },
    {
      sourceId: 'b',
      translations: [
        { languageId: 'ko', text: '세계' },
        { languageId: 'vi', text: 'Thế giới' },
      ],
    },
  ]);
});

it('stops advisory publication at the first invalid row', () => {
  const published = [];
  const observer = createTranslationStreamObserver({
    languageIds: ['vi'],
    sourceRows,
    onRows: (rows) => published.push(...rows),
  });
  observer.feed('{"schemaVersion":2,"rows":[');
  observer.feed('{"ordinal":1,"translations":["Sai"]},');
  observer.feed('{"ordinal":1,"translations":["Đúng"]}]}');
  expect(published).toEqual([]);
});
