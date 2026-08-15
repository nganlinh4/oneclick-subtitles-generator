import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { downloadUrlToUserDestination } from '../../platform/userMediaExportFlow';
import UnifiedUrlInput from './UnifiedUrlInput';

vi.mock('../../platform/userMediaExportFlow', () => ({
  downloadUrlToUserDestination: vi.fn(),
}));
vi.mock('../../platform/desktopYoutubeService', () => ({
  getVideoDetails: vi.fn(),
  getVideoThumbnail: vi.fn(),
}));
vi.mock('../../utils/historyUtils', () => ({
  addYoutubeUrlToHistory: vi.fn(),
  addAllSitesUrlToHistory: vi.fn(),
  formatTimestamp: vi.fn(() => ''),
}));
vi.mock('./urlHistory', () => ({
  addDouyinUrlToHistory: vi.fn(),
  loadHistory: vi.fn(),
  handleSelectFromHistory: vi.fn(),
}));
vi.mock('./VideoPreviewRenderer', () => ({
  getUrlIcon: () => null,
  getPlaceholderText: () => 'Video URL',
  renderExamples: () => null,
  renderVideoPreview: ({ handleDouyinDirectDownload }) => (
    <button type="button" onClick={handleDouyinDirectDownload}>Direct export</button>
  ),
}));
vi.mock('../DownloadOnlyModal', () => ({ default: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  downloadUrlToUserDestination.mockResolvedValue({ status: 'completed' });
});

it('propagates the selected browser source through Unified URL direct export', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'vivaldi');
  render(
    <UnifiedUrlInput
      setSelectedVideo={vi.fn()}
      selectedVideo={{
        id: 'douyin-id',
        url: 'https://www.douyin.com/video/1234567890',
        source: 'douyin',
        title: 'Douyin video',
      }}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: 'Direct export' }));

  await waitFor(() => expect(downloadUrlToUserDestination).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://www.douyin.com/video/1234567890',
      cookieSource: 'vivaldi',
      media: { kind: 'video', quality: { mode: 'best' } },
    })
  ));
});
