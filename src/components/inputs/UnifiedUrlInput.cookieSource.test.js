import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { downloadUrlToUserDestination } from '../../platform/userMediaExportFlow';
import { getVideoDetails } from '../../platform/desktopYoutubeService';
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
  getVideoDetails.mockResolvedValue({ title: 'Video B', thumbnail: '' });
});

it('stages URL B without overwriting active media A compatibility identity', async () => {
  const setSelectedVideo = vi.fn();
  const videoChanged = vi.fn();
  localStorage.setItem('current_video_url', 'https://youtube.com/watch?v=AAAAAAAAAAA');
  localStorage.setItem('current_file_url', 'http://127.0.0.1/active-a');
  localStorage.setItem('latest_segment_subtitles', 'owned-by-a');
  window.addEventListener('video-changed', videoChanged);
  try {
    render(<UnifiedUrlInput setSelectedVideo={setSelectedVideo} selectedVideo={null} />);
    fireEvent.change(screen.getByPlaceholderText('Video URL'), {
      target: { value: 'https://youtube.com/watch?v=BBBBBBBBBBB' },
    });

    await waitFor(() => expect(setSelectedVideo).toHaveBeenCalledWith(expect.objectContaining({
      id: 'BBBBBBBBBBB',
      url: 'https://youtube.com/watch?v=BBBBBBBBBBB',
    })));
    expect(localStorage.getItem('current_video_url'))
      .toBe('https://youtube.com/watch?v=AAAAAAAAAAA');
    expect(localStorage.getItem('current_file_url')).toBe('http://127.0.0.1/active-a');
    expect(localStorage.getItem('latest_segment_subtitles')).toBe('owned-by-a');
    expect(videoChanged).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('video-changed', videoChanged);
  }
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
