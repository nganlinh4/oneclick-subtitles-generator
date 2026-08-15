import {
  abortedFailure,
  candidateAssetId,
  fixedFailure,
  normalizeCallback,
  normalizeCookieSource,
  normalizePreferredLanguages,
  normalizeUrl,
  progressPercent,
  selectSubtitle,
  snapshotDownloadRequest,
  snapshotSignal,
} from './nativeUrlDownloadContract';

const validRequest = () => ({ url: 'https://example.com/video', cookieSource: 'none' });

it('raises only fixed, bounded failure codes', () => {
  expect(fixedFailure('mediaOpenFailed')).toMatchObject({
    name: 'NativeUrlDownloadError',
    code: 'mediaOpenFailed',
    message: 'The native media download could not be completed',
  });
  expect(fixedFailure()).toMatchObject({ code: 'nativeDownloadFailed' });
  expect(abortedFailure()).toMatchObject({
    name: 'AbortError',
    code: 'nativeDownloadAborted',
  });
});

it.each([
  ['a hyphenated code', 'invalid-code'],
  ['a code opening with a digit', '1code'],
  ['an over-long code', `a${'b'.repeat(200)}`],
  ['a non-string code', 42],
  ['a control character', 'code\u0000'],
])('collapses %s to the default failure code', (_label, code) => {
  expect(fixedFailure(code).code).toBe('nativeDownloadFailed');
});

it('clamps native progress to whole percent', () => {
  const at = (basisPoints) => progressPercent({ job: { progress: { basisPoints } } });
  expect(at(0)).toBe(0);
  expect(at(2_500)).toBe(25);
  expect(at(10_000)).toBe(100);
  expect(at(20_000)).toBe(100);
  expect(at(-500)).toBe(0);
});

it('normalizes, lowercases and deduplicates preferred languages', () => {
  expect(normalizePreferredLanguages(undefined)).toEqual([]);
  const normalized = normalizePreferredLanguages(['EN-us', 'en-US', 'fr']);
  expect(normalized).toEqual(['en-us', 'fr']);
  expect(Object.isFrozen(normalized)).toBe(true);
});

it.each([
  ['a non-array', () => 'en'],
  ['an over-long list', () => Array.from({ length: 33 }, (_value, index) => `l${index}`)],
  ['a non-language entry', () => ['en', 'zh Hans']],
  ['an extra own property', () => Object.assign(['en'], { evil: 'x' })],
  ['an accessor element', () => {
    const languages = ['en'];
    Object.defineProperty(languages, '0', { enumerable: true, get: () => 'en' });
    return languages;
  }],
  ['a non-enumerable element', () => {
    const languages = ['en'];
    Object.defineProperty(languages, '0', { enumerable: false, value: 'en' });
    return languages;
  }],
])('rejects hostile preferred languages: %s', (_label, build) => {
  expect(() => normalizePreferredLanguages(build())).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );
});

it('snapshots a request without invoking accessors or inherited properties', () => {
  const snapshot = snapshotDownloadRequest(validRequest());
  expect(snapshot).toEqual(validRequest());
  expect(Object.isFrozen(snapshot)).toBe(true);
});

it.each([
  ['null', () => null],
  ['an array', () => []],
  ['an inherited prototype', () => Object.assign(Object.create({ evil: true }), validRequest())],
  ['an unknown key', () => ({ ...validRequest(), path: 'C:\\private\\clip.mp4' })],
  ['a missing url', () => ({ cookieSource: 'none' })],
  ['a missing cookie source', () => ({ url: 'https://example.com/video' })],
  ['an accessor url', () => {
    const request = validRequest();
    Object.defineProperty(request, 'url', { enumerable: true, get: () => 'https://evil.test' });
    return request;
  }],
  ['a non-enumerable cookie source', () => {
    const request = validRequest();
    Object.defineProperty(request, 'cookieSource', { enumerable: false, value: 'none' });
    return request;
  }],
])('rejects a hostile request: %s', (_label, build) => {
  expect(() => snapshotDownloadRequest(build())).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );
});

it.each([
  ['an empty URL', ''],
  ['a non-string URL', 7],
  ['a backslash', 'https://example.com\\evil'],
  ['a control character', 'https://example.com/\u0007'],
  ['an over-long URL', `https://example.com/${'a'.repeat(8_200)}`],
])('rejects a hostile URL: %s', (_label, url) => {
  expect(() => normalizeUrl(url)).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );
});

it('captures signal methods once without trusting later mutation', () => {
  expect(snapshotSignal(undefined)).toBeNull();
  const controller = new AbortController();
  const binding = snapshotSignal(controller.signal);
  expect(Object.isFrozen(binding)).toBe(true);
  expect(binding.target).toBe(controller.signal);
  expect(typeof binding.add).toBe('function');
  expect(typeof binding.remove).toBe('function');
});

it.each([
  ['null', () => null],
  ['a plain object', () => ({})],
  ['a listener-free object', () => ({ addEventListener: () => undefined })],
  ['a throwing accessor', () => new Proxy({}, {
    get() { throw new Error('hostile signal'); },
  })],
])('rejects a hostile signal: %s', (_label, build) => {
  expect(() => snapshotSignal(build())).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );
});

it('accepts only callables and reviewed cookie sources', () => {
  const callback = () => undefined;
  expect(normalizeCallback(undefined)).toBeUndefined();
  expect(normalizeCallback(callback)).toBe(callback);
  expect(() => normalizeCallback('nope')).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );

  expect(normalizeCookieSource('none')).toBe('none');
  expect(() => normalizeCookieSource('netscape')).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );
  expect(() => normalizeCookieSource(true)).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );
});

it('prefers the earliest requested language and a manual track within it', () => {
  const inventory = {
    subtitles: [
      { language: 'en-GB', source: 'automatic' },
      { language: 'en-US', source: 'manual' },
      { language: 'fr', source: 'manual' },
    ],
  };
  expect(selectSubtitle(inventory, ['fr', 'en'])).toEqual({ language: 'fr', source: 'manual' });
  expect(selectSubtitle(inventory, ['en'])).toEqual({ language: 'en-US', source: 'manual' });
  expect(selectSubtitle(inventory, ['de'])).toBeNull();
  expect(selectSubtitle(inventory, [])).toBeNull();
  expect(selectSubtitle({}, ['en'])).toBeNull();
  expect(Object.isFrozen(selectSubtitle(inventory, ['fr']))).toBe(true);
});

it('reads a candidate asset ID without invoking hostile accessors', () => {
  expect(candidateAssetId({ asset: { id: 'asset-1' } })).toBe('asset-1');
});

it.each([
  ['a missing asset', () => ({})],
  ['a null asset', () => ({ asset: null })],
  ['a non-string ID', () => ({ asset: { id: 7 } })],
  ['an accessor ID', () => {
    const candidate = { asset: {} };
    Object.defineProperty(candidate.asset, 'id', { enumerable: true, get: () => 'asset-1' });
    return candidate;
  }],
  ['an accessor asset', () => {
    const candidate = {};
    Object.defineProperty(candidate, 'asset', { enumerable: true, get: () => ({ id: 'a' }) });
    return candidate;
  }],
])('rejects a hostile candidate: %s', (_label, build) => {
  expect(() => candidateAssetId(build())).toThrow(
    expect.objectContaining({ code: 'invalidDownloadResponse' })
  );
});
