import {
  clearBrowserMediaBlobs,
  forgetBrowserMediaBlob,
  getBrowserMediaBlob,
  registerBrowserMediaBlob,
} from './browserMediaBlobRegistry';

beforeEach(() => clearBrowserMediaBlobs());

test('keeps browser media bytes module-owned and forgets them explicitly', () => {
  const blob = new Blob(['video'], { type: 'video/mp4' });
  registerBrowserMediaBlob('blob:one', blob);
  expect(getBrowserMediaBlob('blob:one')).toBe(blob);
  expect(window.__videoBlobMap).toBeUndefined();
  expect(forgetBrowserMediaBlob('blob:one')).toBe(true);
  expect(getBrowserMediaBlob('blob:one')).toBeNull();
});

test('bounds retained object URLs without revoking URLs owned by callers', () => {
  for (let index = 0; index < 17; index += 1) {
    registerBrowserMediaBlob(`blob:${index}`, new Blob([String(index)]));
  }
  expect(getBrowserMediaBlob('blob:0')).toBeNull();
  expect(getBrowserMediaBlob('blob:1')).toBeInstanceOf(Blob);
  expect(getBrowserMediaBlob('blob:16')).toBeInstanceOf(Blob);
});

test('refuses non-blob URLs and non-Blob payloads', () => {
  expect(() => registerBrowserMediaBlob('https://example.test/video', new Blob())).toThrow();
  expect(() => registerBrowserMediaBlob('blob:one', {})).toThrow();
  expect(getBrowserMediaBlob('https://example.test/video')).toBeNull();
});
