import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./common/LoadingIndicator', () => ({
  default: () => <span data-testid="loading-indicator" />,
}));

import SrtUploadButton from './SrtUploadButton';

const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};

test('keeps import processing active until the durable handler settles', async () => {
  const pending = deferred();
  const onSrtUpload = vi.fn(() => pending.promise);
  const view = render(<SrtUploadButton onSrtUpload={onSrtUpload} />);
  const input = view.container.querySelector('input[type="file"]');

  fireEvent.change(input, {
    target: { files: [new File(['caption'], 'captions.srt', { type: 'text/plain' })] },
  });
  await waitFor(() => expect(onSrtUpload).toHaveBeenCalledExactlyOnceWith('caption', 'captions.srt'));
  expect(screen.getByRole('button', { name: /processing/i })).toBeDisabled();

  pending.resolve({ status: 'accepted' });
  await waitFor(() => expect(screen.getByRole('button', { name: /upload srt\/json/i })).not.toBeDisabled());
});

test('keeps clear processing active until exact-project deletion settles', async () => {
  const pending = deferred();
  const onSrtClear = vi.fn(() => pending.promise);
  render(
    <SrtUploadButton
      onSrtUpload={vi.fn()}
      onSrtClear={onSrtClear}
      hasSrtUploaded
      uploadedFileName="captions.srt"
    />
  );

  fireEvent.click(screen.getByRole('button', { name: /clear uploaded/i }));
  expect(onSrtClear).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: /processing/i })).toBeDisabled();

  pending.resolve({ status: 'cleared' });
  await waitFor(() => expect(screen.getByRole('button', { name: /captions\.srt/i })).not.toBeDisabled());
});
