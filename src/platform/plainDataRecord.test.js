import {
  hasExactKeys,
  hasOnlyKeys,
  isAbortSignalLike,
  isNativeErrorCode,
  isPlainDataRecord,
  isRecord,
  snapshotExactRecord,
  snapshotNativeError,
  snapshotPlainRecord,
  utf8ByteLength,
} from './plainDataRecord';

class Instance {
  constructor() {
    this.code = 'x';
  }
}

const withGetter = () => Object.defineProperty({}, 'code', { enumerable: true, get: () => 'x' });
const withSymbol = () => ({ code: 'x', [Symbol('hidden')]: 1 });
const hiddenKey = () => Object.defineProperty({ code: 'x' }, 'message', { value: 'm' });
const throwingProxy = () => new Proxy({}, {
  getPrototypeOf() {
    throw new Error('hostile');
  },
});

describe('isRecord', () => {
  it('accepts plain and null-prototype objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(Object.freeze({ a: 1 }))).toBe(true);
  });

  it('rejects arrays, class instances, built-ins, primitives and hostile proxies', () => {
    for (const value of [[], new Instance(), new Map(), new Date(0), new AbortController().signal,
      null, undefined, 'x', 1, () => {}, throwingProxy()]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe('isPlainDataRecord', () => {
  it('additionally rejects accessors, symbol keys and non-enumerable keys', () => {
    expect(isPlainDataRecord({ code: 'x' })).toBe(true);
    expect(isPlainDataRecord(withGetter())).toBe(false);
    expect(isPlainDataRecord(withSymbol())).toBe(false);
    expect(isPlainDataRecord(hiddenKey())).toBe(false);
    expect(isPlainDataRecord([])).toBe(false);
    expect(isPlainDataRecord(new Instance())).toBe(false);
  });
});

describe('hasExactKeys / hasOnlyKeys', () => {
  it('compares an unordered key array exactly', () => {
    expect(hasExactKeys({ b: 1, a: 2 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: undefined }, ['a'])).toBe(true);
  });

  it('allows a subset of the listed keys and none outside it', () => {
    expect(hasOnlyKeys({}, ['a', 'b'])).toBe(true);
    expect(hasOnlyKeys({ a: 1 }, ['a', 'b'])).toBe(true);
    expect(hasOnlyKeys({ c: 1 }, ['a', 'b'])).toBe(false);
  });

  it('refuses non-data records whatever their keys', () => {
    for (const value of [[], new Instance(), withGetter(), withSymbol()]) {
      expect(hasExactKeys(value, ['code'])).toBe(false);
      expect(hasOnlyKeys(value, ['code'])).toBe(false);
    }
  });
});

describe('snapshots', () => {
  it('returns a frozen copy that later mutation of the source cannot reach', () => {
    const source = { a: 1, b: 2 };
    const snapshot = snapshotPlainRecord(source);
    source.a = 9;
    expect(snapshot).toEqual({ a: 1, b: 2 });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('returns null for non-data records and key-set mismatches', () => {
    expect(snapshotPlainRecord(withGetter())).toBeNull();
    expect(snapshotPlainRecord([])).toBeNull();
    expect(snapshotExactRecord({ a: 1 }, ['a', 'b'])).toBeNull();
    expect(snapshotExactRecord({ b: 1, a: 2 }, ['a', 'b'])).toEqual({ a: 2, b: 1 });
  });
});

describe('native error codes', () => {
  it('accepts a letter followed by at most 127 alphanumerics', () => {
    expect(isNativeErrorCode('a')).toBe(true);
    expect(isNativeErrorCode(`a${'b'.repeat(127)}`)).toBe(true);
    expect(isNativeErrorCode(`a${'b'.repeat(128)}`)).toBe(false);
    for (const value of ['', '1abc', 'with space', 'kebab-case', 'snake_case', null, 7]) {
      expect(isNativeErrorCode(value)).toBe(false);
    }
  });

  it('snapshots exactly a { code, message } failure record', () => {
    expect(snapshotNativeError({ code: 'busy', message: 'm' })).toEqual({ code: 'busy', message: 'm' });
    expect(snapshotNativeError({ code: 'busy', message: 'm', trace: 't' })).toBeNull();
    expect(snapshotNativeError({ code: 'bad code', message: 'm' })).toBeNull();
    expect(snapshotNativeError({ code: 'busy', message: 1 })).toBeNull();
    expect(snapshotNativeError(Object.assign(new Instance(), { message: 'm' }))).toBeNull();
  });
});

describe('isAbortSignalLike', () => {
  it('accepts a real AbortSignal and a duck-typed one', () => {
    expect(isAbortSignalLike(new AbortController().signal)).toBe(true);
    expect(isAbortSignalLike({
      aborted: false, addEventListener: () => {}, removeEventListener: () => {},
    })).toBe(true);
  });

  it('rejects incomplete shapes and throwing getters', () => {
    expect(isAbortSignalLike({ aborted: false })).toBe(false);
    expect(isAbortSignalLike(null)).toBe(false);
    expect(isAbortSignalLike(Object.defineProperty({}, 'aborted', {
      get() {
        throw new Error('hostile');
      },
    }))).toBe(false);
  });
});

describe('utf8ByteLength', () => {
  it('matches TextEncoder, including lone surrogates as U+FFFD', () => {
    for (const value of ['', 'abc', 'é', '€', '😀', 'a😀b', '\uD800', 'x\uDC00y']) {
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
    }
  });
});
