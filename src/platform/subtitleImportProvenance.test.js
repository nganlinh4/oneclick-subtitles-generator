import {
  bindPendingSubtitleImportProvenance,
  clearSubtitleImportProvenance,
  readSubtitleImportProvenance,
  subtitleImportFileNameForCache,
  writeSubtitleImportProvenance,
} from './subtitleImportProvenance';

beforeEach(() => localStorage.clear());

test('records a bounded import identity under its exact project alias', () => {
  expect(writeSubtitleImportProvenance({ cacheId: 'asset-a', fileName: 'captions.srt' })).toBe(true);
  expect(readSubtitleImportProvenance()).toEqual({ cacheId: 'asset-a', fileName: 'captions.srt' });
  expect(subtitleImportFileNameForCache('asset-a')).toBe('captions.srt');
  expect(subtitleImportFileNameForCache('asset-b')).toBe('');
});

test('binds only a pending SRT-first import and never reassigns another project provenance', () => {
  writeSubtitleImportProvenance({ fileName: 'captions.srt' });
  expect(bindPendingSubtitleImportProvenance('asset-a')).toEqual({
    cacheId: 'asset-a', fileName: 'captions.srt',
  });
  expect(bindPendingSubtitleImportProvenance('asset-b')).toBeNull();
  expect(readSubtitleImportProvenance()).toEqual({ cacheId: 'asset-a', fileName: 'captions.srt' });
});

test('conditional clear cannot erase another active project provenance', () => {
  writeSubtitleImportProvenance({ cacheId: 'asset-b', fileName: 'other.json' });
  expect(clearSubtitleImportProvenance({ expectedCacheId: 'asset-a' })).toBe(false);
  expect(readSubtitleImportProvenance()).toEqual({ cacheId: 'asset-b', fileName: 'other.json' });
  expect(clearSubtitleImportProvenance({ expectedCacheId: 'asset-b' })).toBe(true);
  expect(readSubtitleImportProvenance()).toBeNull();
});

test('does not claim a pending import was bound when storage rejects the update', () => {
  const stored = JSON.stringify({ v: 2, cacheId: null, fileName: 'captions.srt' });
  const storage = {
    getItem: vi.fn(() => stored),
    setItem: vi.fn(() => { throw new Error('quota'); }),
  };
  expect(bindPendingSubtitleImportProvenance('asset-a', { storage })).toBeNull();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
});

test.each([
  ['legacy global shape', { hasUploaded: true, fileName: 'old.srt', source: 'srt' }],
  ['unknown field', { v: 2, cacheId: null, fileName: 'safe.srt', extra: true }],
  ['path-bearing name', { v: 2, cacheId: null, fileName: '../private.srt' }],
  ['wrong extension', { v: 2, cacheId: null, fileName: 'captions.txt' }],
  ['control-bearing cache', { v: 2, cacheId: 'asset\na', fileName: 'safe.srt' }],
])('refuses %s rather than treating presentation metadata as authority', (_label, value) => {
  localStorage.setItem('uploaded_srt_info', JSON.stringify(value));
  expect(readSubtitleImportProvenance()).toBeNull();
});
