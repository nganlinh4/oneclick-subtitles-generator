import {
  SubtitleDocumentSerializationError,
  normalizeSubtitleDocumentRows,
  secondsToSrtTimestamp,
  serializeJsonSubtitleDocument,
  serializeSrtDocument,
  serializeTextSubtitleDocument,
} from './subtitleDocumentSerializer';

describe('subtitle document serialization', () => {
  test('serializes numeric seconds as canonical SRT timestamps and rounds carries', () => {
    expect(serializeSrtDocument([
      { start: 0, end: 3_661.0066, text: 'Hello' },
    ])).toBe('1\n00:00:00,000 --> 01:01:01,007\nHello');
    expect(secondsToSrtTimestamp(59.9996)).toBe('00:01:00,000');
  });

  test('accepts strict SRT/WebVTT and numeric-string times', () => {
    const rows = normalizeSubtitleDocumentRows([
      { startTime: '00:00:01,250', endTime: '00:00:02.500', text: 'A' },
      { start: '3.5', end: '4', text: 'B' },
    ]);
    expect(rows.map(({ start, end }) => [start, end])).toEqual([[1.25, 2.5], [3.5, 4]]);
  });

  test('rounds decimal-second strings exactly through the safe millisecond bound', () => {
    expect(secondsToSrtTimestamp('9007199254740.991')).toBe('2501999792:59:00,991');
    expect(secondsToSrtTimestamp('2501999792:59:00,991')).toBe('2501999792:59:00,991');
    expect(secondsToSrtTimestamp('9007199254740.9905')).toBe('2501999792:59:00,991');
    expect(secondsToSrtTimestamp('59.9995')).toBe('00:01:00,000');
    expect(secondsToSrtTimestamp('0.000499999')).toBe('00:00:00,000');
    expect(secondsToSrtTimestamp('0.0005')).toBe('00:00:00,001');
  });

  test('rejects oversized time text before Unicode scanning or numeric timestamp conversion', () => {
    const timestampShaped = `${'9'.repeat(100_000)}:59:00,000`;
    const numberSpy = vi.spyOn(globalThis, 'Number');
    const unicodeSpy = vi.spyOn(String.prototype, 'charCodeAt');
    let thrown;
    try {
      secondsToSrtTimestamp(timestampShaped);
    } catch (error) {
      thrown = error;
    } finally {
      numberSpy.mockRestore();
      unicodeSpy.mockRestore();
    }
    expect(thrown).toBeInstanceOf(SubtitleDocumentSerializationError);
    expect(numberSpy).not.toHaveBeenCalled();
    expect(unicodeSpy).not.toHaveBeenCalled();
    expect(() => secondsToSrtTimestamp('2501999792:59:00,992'))
      .toThrow(SubtitleDocumentSerializationError);
  });

  test('round-trips every accepted millisecond through canonical JSON without precision loss', () => {
    const exactMaximumJson = serializeJsonSubtitleDocument([{
      start: '9007199254740.991',
      end: '2501999792:59:00,991',
      text: 'maximum',
    }]);
    const [exactMaximumRow] = JSON.parse(exactMaximumJson);
    expect(exactMaximumRow.start).toBe('9007199254740.991');
    expect(exactMaximumRow.end).toBe('9007199254740.991');
    expect(serializeSrtDocument([exactMaximumRow])).toBe(
      '1\n2501999792:59:00,991 --> 2501999792:59:00,991\nmaximum'
    );

    const ordinaryRows = JSON.parse(serializeJsonSubtitleDocument([
      { start: '1.25', end: '2.5004', text: 'ordinary' },
      { start: '59.9995', end: '60.0004', text: 'carry' },
    ]));
    expect(ordinaryRows.map(({ start, end }) => [start, end])).toEqual([
      [1.25, 2.5],
      [60, 60],
    ]);
    expect(serializeSrtDocument(ordinaryRows)).toContain(
      '2\n00:01:00,000 --> 00:01:00,000\ncarry'
    );
  });

  test('requires seconds and timestamp aliases to describe the same exact millisecond', () => {
    expect(() => serializeSrtDocument([{
      start: 1,
      startTime: '00:00:02,000',
      end: 3,
      endTime: '00:00:03,000',
      text: 'conflict',
    }])).toThrow(SubtitleDocumentSerializationError);
    expect(() => serializeSrtDocument([{
      start: 9_007_199_254_740.99,
      startTime: '2501999792:59:00,991',
      endTime: '2501999792:59:00,991',
      text: 'lossy conflict',
    }])).toThrow(SubtitleDocumentSerializationError);

    const getter = vi.fn(() => '00:00:01,000');
    const hostile = { start: 1, end: 2, text: 'hostile' };
    Object.defineProperty(hostile, 'startTime', { enumerable: true, get: getter });
    expect(() => serializeSrtDocument([hostile])).toThrow(SubtitleDocumentSerializationError);
    expect(getter).not.toHaveBeenCalled();
  });

  test.each([
    '9007199254740.9915',
    '9007199254741',
    '-0.001',
    '+1',
    '.5',
    '1.',
    '1e3',
    '01',
    ' 1',
    `0.${'1'.repeat(65)}`,
    '999999999999999999999999999999999999',
  ])('rejects out-of-bound or non-decimal numeric-string policy input: %s', (value) => {
    expect(() => secondsToSrtTimestamp(value)).toThrow(SubtitleDocumentSerializationError);
  });

  test('preserves text that resembles SRT metadata exactly', () => {
    const text = '2026\n00:00:00,000 --> 00:00:01,000\n"quoted"\n';
    const subtitles = [{ start: 0, end: 1, text }];
    expect(serializeSrtDocument(subtitles)).toBe(`1\n00:00:00,000 --> 00:00:01,000\n${text}`);
    expect(serializeTextSubtitleDocument(subtitles)).toBe(text);
    expect(JSON.parse(serializeJsonSubtitleDocument(subtitles))[0].text).toBe(text);
  });

  test.each([
    [{ start: -1, end: 1, text: 'x' }],
    [{ start: Number.NaN, end: 1, text: 'x' }],
    [{ start: 2, end: 1, text: 'x' }],
    [{ startTime: '00:60:00,000', end: 1, text: 'x' }],
    [{ start: 0, end: 1, text: '\ud800' }],
  ])('rejects malformed rows without coercing them: %o', (row) => {
    expect(() => serializeSrtDocument(row)).toThrow(SubtitleDocumentSerializationError);
  });

  test('rejects accessor-backed subtitle data without invoking it', () => {
    const getter = vi.fn(() => 'secret');
    const subtitle = { start: 0, end: 1 };
    Object.defineProperty(subtitle, 'text', { enumerable: true, get: getter });
    expect(() => serializeSrtDocument([subtitle])).toThrow(SubtitleDocumentSerializationError);
    expect(getter).not.toHaveBeenCalled();
  });

  test('requires every subtitle array index to be an own data descriptor', () => {
    const sparse = new Array(1);
    const indexGetter = vi.fn(() => ({ start: 0, end: 1, text: 'inherited' }));
    const inheritedPrototype = Object.create(Array.prototype);
    Object.defineProperty(inheritedPrototype, '0', {
      configurable: true,
      get: indexGetter,
    });
    Object.setPrototypeOf(sparse, inheritedPrototype);
    expect(() => serializeSrtDocument(sparse)).toThrow(SubtitleDocumentSerializationError);
    expect(indexGetter).not.toHaveBeenCalled();

    const accessorArray = [];
    const ownGetter = vi.fn(() => ({ start: 0, end: 1, text: 'own' }));
    Object.defineProperty(accessorArray, '0', {
      configurable: true,
      enumerable: true,
      get: ownGetter,
    });
    expect(() => serializeSrtDocument(accessorArray)).toThrow(SubtitleDocumentSerializationError);
    expect(ownGetter).not.toHaveBeenCalled();

    const dense = [];
    Object.defineProperty(dense, '0', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: { start: 0, end: 1, text: 'dense' },
    });
    expect(serializeTextSubtitleDocument(dense)).toBe('dense');
  });

  test('fails closed when array reflection traps throw', () => {
    const rows = new Proxy([{ start: 0, end: 1, text: 'x' }], {
      getOwnPropertyDescriptor() {
        throw new Error('observable trap');
      },
    });
    expect(() => serializeSrtDocument(rows)).toThrow(SubtitleDocumentSerializationError);
  });

  test('rejects array length bounds before reflecting over prototypes or indices', () => {
    const prototypeTrap = vi.fn(() => Array.prototype);
    const ownKeysTrap = vi.fn(() => []);
    const oversized = new Proxy(new Array(100_001), {
      getPrototypeOf: prototypeTrap,
      ownKeys: ownKeysTrap,
    });
    expect(() => serializeSrtDocument(oversized)).toThrow(SubtitleDocumentSerializationError);
    expect(prototypeTrap).not.toHaveBeenCalled();
    expect(ownKeysTrap).not.toHaveBeenCalled();
  });
});
