// UI rendering helpers for the unified URL input.

// Get the appropriate icon based on URL type
export const getUrlIcon = (urlType) => {
  switch (urlType) {
    case 'youtube':
      return (
        <span
          className="material-symbols-rounded url-icon"
          aria-hidden="true"
          style={{ fontSize: 24, display: 'inline-block' }}
        >
          ondemand_video
        </span>
      );
    case 'douyin':
      return (
        <span
          className="material-symbols-rounded url-icon"
          aria-hidden="true"
          style={{ fontSize: 24, display: 'inline-block' }}
        >
          music_video
        </span>
      );
    case 'all-sites':
      return (
        <span
          className="material-symbols-rounded url-icon"
          aria-hidden="true"
          style={{ fontSize: 24, display: 'inline-block' }}
        >
          public
        </span>
      );
    default:
      return (
        <span
          className="material-symbols-rounded url-icon"
          aria-hidden="true"
          style={{ fontSize: 24, display: 'inline-block' }}
        >
          public
        </span>
      );
  }
};

// Get the appropriate placeholder text based on URL type
export const getPlaceholderText = (urlType, t) => {
  switch (urlType) {
    case 'youtube':
      return t('youtubeUrlInput.placeholder', 'Enter YouTube URL (e.g., youtube.com/watch?v=...)');
    case 'douyin':
      return t('unifiedUrlInput.placeholder', 'Enter any video URL (YouTube, Douyin, TikTok, etc.)');
    case 'all-sites':
      return t('unifiedUrlInput.placeholder', 'Enter any video URL (YouTube, Douyin, TikTok, etc.)');
    default:
      return t('unifiedUrlInput.placeholder', 'Enter any video URL (YouTube, Douyin, TikTok, etc.)');
  }
};

// Render the appropriate video preview based on URL type
export const renderVideoPreview = ({
  selectedVideo,
  videoTitle,
  url,
  t,
  setShowDownloadModal,
  handleDouyinDirectDownload,
  isDouyinDownloading,
  douyinDownloadProgress
}) => {
  if (!selectedVideo || !selectedVideo.id) return null;

  switch (selectedVideo.source) {
    case 'youtube':
      return (
        <div className="selected-video-preview">
          <img
            src={selectedVideo.thumbnail}
            alt={videoTitle}
            className="thumbnail"
          />
          <div className="video-info">
            <h3 className="video-title">{videoTitle}</h3>
            <p className="video-id">{t('youtubeUrlInput.videoId', 'Video ID:')} <span className="video-id-value">{selectedVideo.id}</span></p>
            <button
              className="download-only-btn"
              onClick={() => setShowDownloadModal(true)}
              title={t('unifiedUrlInput.downloadOnly', 'Download Only')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
              {t('unifiedUrlInput.downloadOnly', 'Download Only')}
            </button>
          </div>
        </div>
      );
    case 'douyin':
      return (
        <div className="selected-video-preview">
          <div className="video-info">
            <h3 className="video-title">{videoTitle}</h3>
            <p className="video-id">{t('unifiedUrlInput.videoId', 'Video ID:')} <span className="video-id-value">{selectedVideo.id}</span></p>
            <button
              className="download-only-btn"
              onClick={handleDouyinDirectDownload}
              disabled={isDouyinDownloading}
              title={t('unifiedUrlInput.downloadOnly', 'Download Only')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
              {isDouyinDownloading
                ? `${t('unifiedUrlInput.downloading', 'Downloading...')} ${douyinDownloadProgress}%`
                : t('unifiedUrlInput.downloadOnly', 'Download Only')
              }
            </button>
          </div>
        </div>
      );
    case 'all-sites':
      return (
        <div className="selected-video-preview">
          <div className="video-info">
            <h3 className="video-title">{videoTitle}</h3>
            <p className="video-url">{t('unifiedUrlInput.url', 'URL:')} <span className="video-url-value">{url}</span></p>
            <button
              className="download-only-btn"
              onClick={() => setShowDownloadModal(true)}
              title={t('unifiedUrlInput.downloadOnly', 'Download Only')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
              {t('unifiedUrlInput.downloadOnly', 'Download Only')}
            </button>
          </div>
        </div>
      );
    default:
      return null;
  }
};

// Open the yt-dlp supported sites documentation
const openSupportedSitesDoc = () => {
  window.open('https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md', '_blank');
};

// Render examples based on URL type
export const renderExamples = ({ selectedVideo, t }) => {
  if (selectedVideo && selectedVideo.id) return null;

  return (
    <div className="url-examples">
      <div className="site-chips">
        <div className="site-chip">youtube.com</div>
        <div className="site-chip">tiktok.com</div>
        <div className="site-chip">vimeo.com</div>
        <div className="site-chip">facebook.com</div>
        <div className="site-chip">instagram.com</div>
        <div className="site-chip">twitter.com</div>
        <div className="site-chip">dailymotion.com</div>
        <div className="site-chip">twitch.tv</div>
        <div className="site-chip">bilibili.com</div>
        <div className="site-chip">douyin.com</div>
        <div className="site-chip">reddit.com</div>
        <div className="site-chip">soundcloud.com</div>
        <div className="site-chip">linkedin.com</div>
        <div className="site-chip">pinterest.com</div>
        <div
          className="site-chip more-sites-chip"
          onClick={openSupportedSitesDoc}
          title={t('unifiedUrlInput.viewAllSupportedSites', 'Click to view all supported sites')}
          role="button"
          tabIndex="0"
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          <span>{t('unifiedUrlInput.hundredsMoreWebsites', '...and hundreds more websites!')}</span>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>
        </div>
      </div>
    </div>
  );
};
