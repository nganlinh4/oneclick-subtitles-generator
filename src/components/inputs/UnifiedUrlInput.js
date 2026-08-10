import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addYoutubeUrlToHistory,
  addAllSitesUrlToHistory,
  formatTimestamp
} from '../../utils/historyUtils';
import { getVideoDetails, getVideoThumbnail } from '../../platform/desktopYoutubeService';
import { downloadUrlToUserDestination } from '../../platform/userMediaExportFlow';
import DownloadOnlyModal from '../DownloadOnlyModal';
import {
  isValidYoutubeUrl,
  isValidDouyinUrl,
  isValidUrl,
  extractYoutubeVideoId,
  extractDouyinVideoId,
  generateAllSitesVideoId
} from './urlValidation';
import {
  addDouyinUrlToHistory,
  loadHistory as loadHistoryHelper,
  handleSelectFromHistory as handleSelectFromHistoryHelper
} from './urlHistory';
import {
  getUrlIcon,
  getPlaceholderText,
  renderVideoPreview,
  renderExamples
} from './VideoPreviewRenderer';

const UnifiedUrlInput = ({ setSelectedVideo, selectedVideo, className }) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const [urlType, setUrlType] = useState(''); // 'youtube', 'douyin', or 'all-sites'
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const historyDropdownRef = useRef(null);
  const inputRef = useRef(null);

  // State for direct Douyin download
  const [isDouyinDownloading, setIsDouyinDownloading] = useState(false);
  const [douyinDownloadProgress, setDouyinDownloadProgress] = useState(0);

  // Load combined history from all sources
  const loadHistory = () => { void loadHistoryHelper(setHistory); };

  useEffect(() => {
    if (selectedVideo) {
      // Check if this is a Douyin URL that was incorrectly classified as all-sites
      if (selectedVideo.source === 'all-sites' && selectedVideo.url && isValidDouyinUrl(selectedVideo.url)) {
        // Convert to douyin
        const videoId = extractDouyinVideoId(selectedVideo.url);
        if (videoId) {
          setSelectedVideo({
            id: videoId,
            url: selectedVideo.url,
            source: 'douyin',
            title: 'Douyin Video',
            thumbnail: ''
          });
          setUrlType('douyin');
          setVideoTitle('Douyin Video');
          return;
        }
      }

      setVideoTitle(selectedVideo.title || 'Video');
      setUrlType(selectedVideo.source);

      // Add to history based on source
      if (selectedVideo.id && selectedVideo.url) {
        if (selectedVideo.source === 'youtube') {
          addYoutubeUrlToHistory(selectedVideo);
        } else if (selectedVideo.source === 'douyin') {
          addDouyinUrlToHistory(selectedVideo);
        } else if (selectedVideo.source === 'all-sites') {
          addAllSitesUrlToHistory(selectedVideo);
        }

        // Refresh history list
        loadHistory();
      }
    }
  }, [selectedVideo, setSelectedVideo]);

  // Load combined history on component mount
  useEffect(() => {
    loadHistory();
  }, []);

  // Handle clicks outside the dropdown to close it
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        historyDropdownRef.current &&
        !historyDropdownRef.current.contains(event.target) &&
        !event.target.closest('.history-button')
      ) {
        setShowHistory(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Fetch YouTube video title
  const fetchYoutubeVideoPreview = async (videoId) => {
    try {
      // Use the YouTube API service to get video details
      const videoDetails = await getVideoDetails(videoId);
      if (videoDetails) {
        return { title: videoDetails.title, thumbnail: videoDetails.thumbnail };
      }
    } catch (error) {
      console.error('Error fetching video title:', error);
      try {
        return { title: null, thumbnail: await getVideoThumbnail(videoId) };
      } catch {
        return { title: null, thumbnail: '' };
      }
    }
    try {
      return { title: null, thumbnail: await getVideoThumbnail(videoId) };
    } catch {
      return { title: null, thumbnail: '' };
    }
  };

  const handleUrlChange = async (e) => {
    const inputUrl = e.target.value.trim();
    setUrl(inputUrl);

    // Clear previous video state when URL changes
    const previousVideoUrl = localStorage.getItem('current_video_url');
    if (previousVideoUrl && previousVideoUrl !== inputUrl) {
      // Clear subtitle-related state when switching videos
      localStorage.removeItem('latest_segment_subtitles');
      // Dispatch event to clear subtitle state in other components
      window.dispatchEvent(new CustomEvent('video-changed', {
        detail: { previousUrl: previousVideoUrl, newUrl: inputUrl }
      }));
    }

    if (!inputUrl) {
      setSelectedVideo(null);
      setUrlType('');
      return;
    }

    localStorage.removeItem('current_file_url');

    // Check for YouTube URL first
    if (isValidYoutubeUrl(inputUrl)) {
      setUrlType('youtube');
      const videoId = extractYoutubeVideoId(inputUrl);
      if (videoId) {
        const preview = await fetchYoutubeVideoPreview(videoId);
        // Store the video URL in localStorage to maintain state
        localStorage.setItem('current_video_url', inputUrl);
        setSelectedVideo({
          id: videoId,
          url: inputUrl,
          source: 'youtube',
          title: preview.title || 'YouTube Video',
          thumbnail: preview.thumbnail
        });
      }
      return;
    }

    // Check for Douyin URL next - USING UNIFIED DOWNLOADER
    if (isValidDouyinUrl(inputUrl)) {
      setUrlType('douyin');
      const videoId = extractDouyinVideoId(inputUrl);
      if (videoId) {
        // Store the video URL in localStorage to maintain state
        localStorage.setItem('current_video_url', inputUrl);
        setSelectedVideo({
          id: videoId,
          url: inputUrl,
          source: 'douyin',
          title: 'Douyin Video', // Default title
          thumbnail: '' // No thumbnail available initially
        });
      }
      return;
    }

    // If not YouTube or Douyin, check if it's a valid URL for all-sites
    if (isValidUrl(inputUrl)) {
      setUrlType('all-sites');
      try {
        const videoId = generateAllSitesVideoId(inputUrl);
        const hostname = new URL(inputUrl).hostname;
        const siteName = hostname.replace(/^www\./, '');

        // Store the video URL in localStorage to maintain state
        localStorage.setItem('current_video_url', inputUrl);

        setSelectedVideo({
          id: videoId,
          url: inputUrl,
          source: 'all-sites',
          title: `Video from ${siteName}`,
          thumbnail: '', // No thumbnail available initially
          type: 'video/mp4' // Explicitly set the type
        });

        // Set video title for display
        setVideoTitle(`Video from ${siteName}`);
      } catch (error) {
        console.error('Error setting up video:', error);
        window.addToast(t('unifiedUrlInput.invalidUrl', 'Invalid URL format. Please enter a valid URL.'), 'error', 5000);
        setSelectedVideo(null);
        setUrlType('');
      }
      return;
    }

    // If we get here, the URL is not valid for any of our supported formats
    window.addToast(t('unifiedUrlInput.invalidUrl', 'Invalid URL format. Please enter a valid URL.'), 'error', 5000);
    setSelectedVideo(null);
    setUrlType('');
  };

  // Toggle history dropdown
  const toggleHistory = () => {
    setShowHistory(prev => !prev);
  };

  // Handle selecting a video from history
  const handleSelectFromHistory = (historyItem) =>
    handleSelectFromHistoryHelper(historyItem, { setUrl, setSelectedVideo, setUrlType, setShowHistory });

  // Direct download function for Douyin videos
  const handleDouyinDirectDownload = async () => {
    if (!selectedVideo || !selectedVideo.url) return;

    setIsDouyinDownloading(true);
    setDouyinDownloadProgress(0);

    try {
      await downloadUrlToUserDestination({
        url: selectedVideo.url,
        cookieSource: localStorage.getItem('use_cookies_for_download') === 'true'
          ? 'chrome'
          : 'none',
        media: { kind: 'video', quality: { mode: 'best' } },
        onDownloadProgress: setDouyinDownloadProgress,
        onExportProgress: setDouyinDownloadProgress,
      });
      setIsDouyinDownloading(false);
    } catch (error) {
      console.error('Error downloading Douyin video:', error);
      setIsDouyinDownloading(false);
      setDouyinDownloadProgress(0);
      alert(t('unifiedUrlInput.downloadFailed', 'Download failed: {{message}}', { message: error.message }));
    }
  };

  return (
    <div className={`unified-url-input ${className || ''}`}>
      <div className="url-input-wrapper">
        <input
          type="text"
          value={url}
          onChange={handleUrlChange}
          placeholder={getPlaceholderText(urlType, t)}
          className="url-field"
          ref={inputRef}
        />
        {getUrlIcon(urlType)}

        {/* History button */}
        {history.length > 0 && (
          <button
            type="button"
            className="history-button"
            onClick={toggleHistory}
            aria-label={t('common.history', 'History')}
            title={t('common.history', 'History')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>schedule</span>
          </button>
        )}

        {url && (
          <button
            type="button"
            className="clear-url-btn"
            onClick={() => {
              setUrl('');
              setSelectedVideo(null);
              setUrlType('');
              // Also clear the video URL from localStorage
              localStorage.removeItem('current_video_url');
            }}
            aria-label="Clear input"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        )}
      </div>


      {/* History dropdown */}
      <div className="history-dropdown-container">
        {history.length > 0 && (
          <div className="history-dropdown" ref={historyDropdownRef} style={{ opacity: showHistory ? 1 : 0, pointerEvents: showHistory ? 'auto' : 'none' }}>
            <div className="history-header">
              <h4 className="history-title">{t('common.recentVideos', 'Recent Videos')}</h4>
            </div>
            <div className="history-list">
              {history.map((item, index) => (
                <div
                  key={`${item.id}-${index}`}
                  className="history-item"
                  onClick={() => handleSelectFromHistory(item)}
                >
                  <div className="history-item-content">
                    {item.source === 'youtube' && item.thumbnail && (
                      <img
                        src={item.thumbnail}
                        alt={item.title}
                        className="history-thumbnail"
                        onError={async (event) => {
                          const image = event.currentTarget;
                          if (image.dataset.nativeThumbnailRetry === 'true') {
                            image.removeAttribute('src');
                            return;
                          }
                          image.dataset.nativeThumbnailRetry = 'true';
                          try {
                            image.src = await getVideoThumbnail(item.id);
                          } catch {
                            image.removeAttribute('src');
                          }
                        }}
                      />
                    )}
                    <div className="history-item-info">
                      <div className="history-item-title">{item.title || 'Video'}</div>
                      <div className="history-item-meta">
                        <span className="history-item-source">{item.source}</span>
                        <span className="history-item-time">{formatTimestamp(item.timestamp)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {renderVideoPreview({
        selectedVideo,
        videoTitle,
        url,
        t,
        setShowDownloadModal,
        handleDouyinDirectDownload,
        isDouyinDownloading,
        douyinDownloadProgress
      })}
      {renderExamples({ selectedVideo, t })}

      {/* Download Only Modal */}
      <DownloadOnlyModal
        isOpen={showDownloadModal}
        onClose={() => setShowDownloadModal(false)}
        videoInfo={selectedVideo}
      />
    </div>
  );
};

export default UnifiedUrlInput;
