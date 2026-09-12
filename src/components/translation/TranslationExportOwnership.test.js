import { act, fireEvent, render } from '@testing-library/react';
import TranslationActions from './TranslationActions';
import TranslationComplete from './TranslationComplete';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('./BulkTranslationPool', () => ({
  default: ({
    onBulkFilesChange,
    onBulkFileRemoval,
    onBulkFilesRemovalAll,
    disabled,
  }) => (
    <div data-testid="bulk-pool" data-disabled={String(disabled)}>
      <button type="button" onClick={() => onBulkFilesChange([])}>pool change</button>
      <button type="button" onClick={() => onBulkFileRemoval('file-1')}>pool remove</button>
      <button type="button" onClick={onBulkFilesRemovalAll}>pool remove all</button>
    </div>
  ),
}));

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const baseActionsProps = () => ({
  isTranslating: false,
  onTranslate: vi.fn(),
  onCancel: vi.fn(),
  bulkFiles: [{ id: 'file-1', name: 'existing.srt', subtitles: [], subtitleCount: 0 }],
  onBulkFilesChange: vi.fn(),
  onBulkFileRemoval: vi.fn(),
  onBulkFilesRemovalAll: vi.fn(),
  hasBulkTranslations: true,
  onDownloadAll: vi.fn(),
  onDownloadZip: vi.fn(),
});

test('the synchronous export owner makes every TranslationActions mutation inert until terminal', async () => {
  const pending = deferred();
  const exportPendingRef = { current: false };
  const props = baseActionsProps();
  props.onDownloadAll.mockImplementation(() => {
    exportPendingRef.current = true;
    return pending.promise.finally(() => {
      exportPendingRef.current = false;
    });
  });

  const { container, getByRole } = render(
    <TranslationActions {...props} exportPendingRef={exportPendingRef} />
  );
  const dropZone = container.querySelector('.bulk-drop-zone');
  const input = container.querySelector('input[type="file"]');
  const inputClick = vi.spyOn(input, 'click').mockImplementation(() => {});
  const queuedFile = { name: 'queued.srt', text: vi.fn() };

  fireEvent.click(container.querySelector('.download-all-button'));
  expect(exportPendingRef.current).toBe(true);

  fireEvent.click(dropZone);
  fireEvent.keyDown(dropZone, { key: 'Enter' });
  fireEvent.keyDown(dropZone, { key: ' ' });
  fireEvent.dragOver(dropZone);
  fireEvent.drop(dropZone, { dataTransfer: { files: [queuedFile] } });
  fireEvent.change(input, { target: { files: [queuedFile] } });
  fireEvent.click(container.querySelector('.translate-button'));
  fireEvent.click(getByRole('button', { name: 'pool change' }));
  fireEvent.click(getByRole('button', { name: 'pool remove' }));
  fireEvent.click(getByRole('button', { name: 'pool remove all' }));
  fireEvent.click(container.querySelector('.download-zip-button'));

  expect(inputClick).not.toHaveBeenCalled();
  expect(queuedFile.text).not.toHaveBeenCalled();
  expect(dropZone).not.toHaveClass('drag-over');
  expect(props.onTranslate).not.toHaveBeenCalled();
  expect(props.onBulkFilesChange).not.toHaveBeenCalled();
  expect(props.onBulkFileRemoval).not.toHaveBeenCalled();
  expect(props.onBulkFilesRemovalAll).not.toHaveBeenCalled();
  expect(props.onDownloadZip).not.toHaveBeenCalled();

  await act(async () => pending.resolve({ status: 'cancelled' }));
  expect(exportPendingRef.current).toBe(false);
  fireEvent.click(container.querySelector('.translate-button'));
  fireEvent.click(dropZone);
  expect(props.onTranslate).toHaveBeenCalledOnce();
  expect(inputClick).toHaveBeenCalledOnce();
});

test('TranslationActions renders its input, translation, and pool controls disabled while exporting', () => {
  const props = baseActionsProps();
  const { container, getByTestId } = render(
    <TranslationActions {...props} isExporting exportPendingRef={{ current: true }} />
  );

  expect(container.querySelector('.bulk-drop-zone')).toHaveAttribute('aria-disabled', 'true');
  expect(container.querySelector('input[type="file"]')).toBeDisabled();
  expect(container.querySelector('.translate-button')).toBeDisabled();
  expect(container.querySelector('.download-all-button')).toBeDisabled();
  expect(container.querySelector('.download-zip-button')).toBeDisabled();
  expect(getByTestId('bulk-pool')).toHaveAttribute('data-disabled', 'true');
});

test('TranslationComplete reset is same-tick inert under the shared export owner and restores at terminal', async () => {
  const pending = deferred();
  const exportPendingRef = { current: false };
  const onReset = vi.fn();
  const onDownloadAll = vi.fn(() => {
    exportPendingRef.current = true;
    return pending.promise.finally(() => {
      exportPendingRef.current = false;
    });
  });
  const { container } = render(
    <TranslationComplete
      onReset={onReset}
      hasBulkTranslations
      onDownloadAll={onDownloadAll}
      onDownloadZip={vi.fn()}
      exportPendingRef={exportPendingRef}
    />
  );

  const reset = container.querySelector('.reset-translation-button');
  fireEvent.click(container.querySelector('.download-all-button'));
  fireEvent.click(reset);
  expect(onReset).not.toHaveBeenCalled();

  await act(async () => pending.resolve({ status: 'saved' }));
  fireEvent.click(reset);
  expect(onReset).toHaveBeenCalledOnce();
});

test('TranslationComplete renders reset disabled while exporting', () => {
  const { container } = render(
    <TranslationComplete
      onReset={vi.fn()}
      isExporting
      exportPendingRef={{ current: true }}
    />
  );
  expect(container.querySelector('.reset-translation-button')).toBeDisabled();
});
