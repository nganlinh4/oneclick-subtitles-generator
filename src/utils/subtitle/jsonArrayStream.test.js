import { JsonArrayStream } from './jsonArrayStream';

it('frames escaped strings, braces, and Unicode across every possible chunk boundary', () => {
  const objects = [{ text: '한글 } "quote" \\ 😀', startTime: '00m01s000ms' }, { text: 'two' }];
  const text = JSON.stringify(objects);
  const stream = new JsonArrayStream();
  const records = [];
  for (let end = 1; end <= text.length; end++) records.push(...stream.append(text.slice(0, end)));
  expect(records.map(record => record.value)).toEqual(objects);
  expect(records.map(record => record.index)).toEqual([0, 1]);
  expect(stream.offset).toBe(text.length);
  expect(stream.done).toBe(true);
  expect(stream.append(text)).toEqual([]);
});

it('publishes completed records without waiting for the array or next subtitle to finish', () => {
  const stream = new JsonArrayStream();
  expect(stream.append('[{"text":"first"}, {"text":"par')).toEqual([{ index: 0, value: { text: 'first' } }]);
  expect(stream.append('[{"text":"first"}, {"text":"partial"}]')).toEqual([{ index: 1, value: { text: 'partial' } }]);
});

it('rejects oversized, shrinking and structurally invalid streams', () => {
  const stream = new JsonArrayStream();
  stream.append('[{}');
  expect(() => stream.append('[')).toThrow('append-only');
  expect(() => new JsonArrayStream().append('x'.repeat(8 * 1024 * 1024 + 1))).toThrow('bounded');
  expect(() => new JsonArrayStream().append('[false]')).toThrow('non-object');
  for (const text of ['[{},]', '[{}{}]', '[,{}]', '["text"]']) {
    expect(() => new JsonArrayStream().append(text)).toThrow();
  }
});

it('processes a long multilingual transcript once while keeping record identities stable', () => {
  const rows = Array.from({ length: 12000 }, (_, index) => ({ text: `row ${index} 한국어 العربية`, index }));
  const text = JSON.stringify(rows);
  const stream = new JsonArrayStream();
  const result = [];
  for (let end = 997; end < text.length; end += 997) result.push(...stream.append(text.slice(0, end)));
  result.push(...stream.append(text));
  expect(result.map(record => record.value)).toEqual(rows);
  expect(stream.records).toBe(rows.length);
  expect(stream.offset).toBe(text.length);
});
