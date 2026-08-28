import { act, fireEvent, render, waitFor } from '@testing-library/react';
import TranslationActions from './TranslationActions';

// TranslationActions.js's own drop zone (BulkTranslationPool is always mounted with
// hideDropZone -- see BulkTranslationPool.js's `{!hideDropZone && (...)}` guard) is the ONLY bulk
// drop target that actually ships. Before this fix, a rejected file (wrong extension, duplicate
// name, malformed JSON) was only `console.warn`'d -- no toast, no inline message, nothing the
// customer could see. These regressions fail against that old behavior: `window.addToast` is
// never called without the fix.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolates {{param}} placeholders like the real i18next backend, so assertions can check
    // actual rendered content (filenames, counts, reasons) instead of a literal `{{token}}`.
    t: (_key, fallback, params) => (
      params
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params[name] ?? ''))
        : fallback
    ),
  }),
}));

const baseProps = () => ({
  isTranslating: false,
  onTranslate: vi.fn(),
  onCancel: vi.fn(),
  bulkFiles: [],
  onBulkFilesChange: vi.fn(),
});

// Duck-typed File stand-ins -- addFiles/parseFile only ever touch `.name` and `.text()`, and the
// sibling TranslationExportOwnership.test.js already establishes this as the project's pattern
// for exercising the drop zone without constructing real File/DataTransfer objects.
const mockFile = (name, content = '') => ({ name, text: () => Promise.resolve(content) });

const dropFiles = async (container, files) => {
  const dropZone = container.querySelector('.bulk-drop-zone');
  await act(async () => {
    fireEvent.drop(dropZone, { dataTransfer: { files } });
  });
};

beforeEach(() => {
  window.addToast = vi.fn();
});

test('a wrong-extension drop surfaces exactly one bounded warning toast naming the file', async () => {
  const props = baseProps();
  const { container } = render(<TranslationActions {...props} />);

  await dropFiles(container, [mockFile('notes.txt')]);

  await waitFor(() => expect(window.addToast).toHaveBeenCalledTimes(1));
  const [message, type] = window.addToast.mock.calls[0];
  expect(type).toBe('warning');
  expect(message).toContain('notes.txt');
  expect(message).toMatch(/unsupported file type/i);
  expect(props.onBulkFilesChange).not.toHaveBeenCalled();
});

test('a duplicate-name drop is refused with a toast naming only the filename, never a filesystem path', async () => {
  const props = baseProps();
  props.bulkFiles = [{ id: 1, name: 'alpha.srt', subtitles: [], subtitleCount: 0 }];
  const { container } = render(<TranslationActions {...props} />);

  await dropFiles(container, [mockFile('alpha.srt')]);

  await waitFor(() => expect(window.addToast).toHaveBeenCalledTimes(1));
  const [message] = window.addToast.mock.calls[0];
  expect(message).toContain('alpha.srt');
  expect(message).toMatch(/already added/i);
  // No absolute filesystem path (Windows drive letter or POSIX home dir) ever reaches the toast.
  expect(message).not.toMatch(/[A-Za-z]:\\|\/(?:home|Users)\//);
  expect(props.onBulkFilesChange).not.toHaveBeenCalled();
});

test('a malformed-JSON drop is refused with the parser reason, not silently dropped', async () => {
  const props = baseProps();
  const { container } = render(<TranslationActions {...props} />);

  await dropFiles(container, [mockFile('broken.json', '{not valid json')]);

  await waitFor(() => expect(window.addToast).toHaveBeenCalledTimes(1));
  const [message] = window.addToast.mock.calls[0];
  expect(message).toContain('broken.json');
  expect(message).toMatch(/could not be read/i);
});

test('multiple rejections from one drop produce exactly ONE grouped toast, not a toast storm', async () => {
  const props = baseProps();
  props.bulkFiles = [{ id: 1, name: 'existing.srt', subtitles: [], subtitleCount: 0 }];
  const { container } = render(<TranslationActions {...props} />);

  await dropFiles(container, [
    mockFile('notes.txt'),
    mockFile('existing.srt'),
    mockFile('broken.json', '{not valid json'),
  ]);

  await waitFor(() => expect(window.addToast).toHaveBeenCalledTimes(1));
  const [message] = window.addToast.mock.calls[0];
  expect(message).toContain('3');
  expect(message).toContain('notes.txt');
  expect(message).toContain('existing.srt');
  expect(message).toContain('broken.json');
});

test('a bounded drop of many rejections truncates the detail list instead of growing without bound', async () => {
  const props = baseProps();
  const { container } = render(<TranslationActions {...props} />);
  const files = Array.from({ length: 5 }, (_unused, i) => mockFile(`bad-${i}.txt`));

  await dropFiles(container, files);

  await waitFor(() => expect(window.addToast).toHaveBeenCalledTimes(1));
  const [message] = window.addToast.mock.calls[0];
  expect(message).toContain('bad-0.txt');
  expect(message).toContain('bad-1.txt');
  expect(message).toContain('bad-2.txt');
  expect(message).not.toContain('bad-3.txt');
  expect(message).not.toContain('bad-4.txt');
  expect(message).toMatch(/\+2 more/);
});

test('a valid file dropped alongside a rejected one is still added; only the bad one is reported', async () => {
  const props = baseProps();
  const { container } = render(<TranslationActions {...props} />);

  await dropFiles(container, [
    mockFile('good.srt', '1\n00:00:00,000 --> 00:00:01,000\nHello\n'),
    mockFile('bad.exe'),
  ]);

  await waitFor(() => expect(props.onBulkFilesChange).toHaveBeenCalledTimes(1));
  const [nextFiles] = props.onBulkFilesChange.mock.calls[0];
  expect(nextFiles).toHaveLength(1);
  expect(nextFiles[0].name).toBe('good.srt');

  await waitFor(() => expect(window.addToast).toHaveBeenCalledTimes(1));
  expect(window.addToast.mock.calls[0][0]).toContain('bad.exe');
});

test('a drop with nothing rejected never shows a toast', async () => {
  const props = baseProps();
  const { container } = render(<TranslationActions {...props} />);

  await dropFiles(container, [
    mockFile('clean.srt', '1\n00:00:00,000 --> 00:00:01,000\nHello\n'),
  ]);

  await waitFor(() => expect(props.onBulkFilesChange).toHaveBeenCalledTimes(1));
  expect(window.addToast).not.toHaveBeenCalled();
});
