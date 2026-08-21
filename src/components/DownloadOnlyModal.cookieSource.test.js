import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { downloadUrlToUserDestination } from '../platform/userMediaExportFlow';
import { showSuccessToast } from '../utils/toastUtils';
import DownloadOnlyModal from './DownloadOnlyModal';

vi.mock('../platform/userMediaExportFlow', () => ({
  downloadUrlToUserDestination: vi.fn(),
}));
vi.mock('../utils/qualityScanner', () => ({ scanVideoQualities: vi.fn() }));
vi.mock('../utils/downloadOnlyUtils', () => ({ cancelDownloadOnly: vi.fn() }));
vi.mock('../utils/toastUtils', () => ({ showErrorToast: vi.fn(), showSuccessToast: vi.fn() }));
vi.mock('./common/CloseButton', () => ({ default: () => null }));
vi.mock('./common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('./common/WavyProgressIndicator', () => ({ default: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  downloadUrlToUserDestination.mockResolvedValue({ status: 'completed' });
});

it('propagates the selected browser source through Download Only export', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'brave');
  render(
    <DownloadOnlyModal
      isOpen={true}
      onClose={vi.fn()}
      videoInfo={{ url: 'https://example.com/download-only' }}
    />
  );

  fireEvent.click(screen.getByRole('radio', { name: /Audio/i }));
  fireEvent.click(screen.getByRole('button', { name: /Download/i }));

  await waitFor(() => expect(downloadUrlToUserDestination).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://example.com/download-only',
      cookieSource: 'brave',
      media: { kind: 'audio', quality: { mode: 'best' }, format: 'mp3' },
    })
  ));
  expect(showSuccessToast).toHaveBeenCalledWith(
    'Download complete. The file was saved to the location you selected.'
  );
});
