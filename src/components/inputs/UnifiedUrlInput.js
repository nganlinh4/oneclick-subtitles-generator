import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addYoutubeUrlToHistory,
  getYoutubeUrlHistory,
  addAllSitesUrlToHistory,
  getAllSitesUrlHistory,
  formatTimestamp
} from '../../utils/historyUtils';
import { getVideoDetails } from '../../services/youtubeApiService';
import { downloadDouyinVideo } from '../../utils/douyinDownloader';
import DownloadOnlyModal from '../DownloadOnlyModal';

// Helper functions for Douyin URL history
const getDouyinUrlHistory = () => {
  try {
    const history = JSON.parse(localStorage.getItem('douyin_url_history') || '[]');
    return Array.isArray(history) ? history : [];
  } catch (error) {
    console.error('Error parsing Douyin URL history:', error);
    return [];
  }
};

const addDouyinUrlToHistory = (video) => {
  try {
    if (!video || !video.id || !video.url) return;

    const history = getDouyinUrlHistory();

    // Check if this URL is already in history
    const existingIndex = history.findIndex(item => item.id === video.id);

    // If it exists, remove it (we'll add it to the top)
    if (existingIndex !== -1) {
      history.splice(existingIndex, 1);
    }

    // Add to the beginning of the array
    history.unshift({
      id: video.id,
      url: video.url,
      title: video.title || 'Douyin Video',
      timestamp: Date.now()
    });

    // Keep only the most recent 20 items
    const trimmedHistory = history.slice(0, 20);

    // Save back to localStorage
    localStorage.setItem('douyin_url_history', JSON.stringify(trimmedHistory));
  } catch (error) {
    console.error('Error saving Douyin URL to history:', error);
  }
};

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
  }, [selectedVideo]);

  // Load combined history on component mount
  useEffect(() => {
    loadHistory();
  }, []);

  // Load combined history from all sources
  const loadHistory = () => {
    const youtubeHistory = getYoutubeUrlHistory().map(item => ({ ...item, source: 'youtube' }));
    const douyinHistory = getDouyinUrlHistory().map(item => ({ ...item, source: 'douyin' }));
    const allSitesHistory = getAllSitesUrlHistory().map(item => ({ ...item, source: 'all-sites' }));

    // Combine and sort by timestamp (newest first)
    const combinedHistory = [...youtubeHistory, ...douyinHistory, ...allSitesHistory]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20); // Keep only the most recent 20 items

    setHistory(combinedHistory);
  };

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

  // URL validation functions
  const isValidYoutubeUrl = (url) => {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})(\S*)?$/;
    return youtubeRegex.test(url);
  };

  const isValidDouyinUrl = (url) => {
    const douyinRegex = /^(https?:\/\/)?(www\.|v\.)?douyin\.com\/(video\/\d+|[a-zA-Z0-9]+\/?.*)/;
    return douyinRegex.test(url);
  };

  const isValidUrl = (url) => {
    if (!url) return false;

    // First, check if it's a valid URL format
    try {
      new URL(url);
    } catch (e) {
      return false;
    }

    // Then check if it has a domain name
    const domainRegex = /^https?:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?/i;
    return domainRegex.test(url);
  };

  // ID extraction functions
  const extractYoutubeVideoId = (url) => {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[7].length === 11) ? match[7] : null;
  };

  const extractDouyinVideoId = (url) => {
    // Extract ID from full URL format: https://www.douyin.com/video/7123456789012345678
    const fullUrlMatch = url.match(/douyin\.com\/video\/(\d+)/);
    if (fullUrlMatch && fullUrlMatch[1]) {
      return fullUrlMatch[1];
    }

    // Extract ID from short URL format: https://v.douyin.com/ABC123/
    const shortUrlMatch = url.match(/v\.douyin\.com\/([a-zA-Z0-9]+)/);
    if (shortUrlMatch && shortUrlMatch[1]) {
      return shortUrlMatch[1];
    }

    return null;
  };

  const generateAllSitesVideoId = (url) => {
    // Generate a unique ID based on the URL
    try {
      // First, try to create a more reliable ID
      const urlObj = new URL(url);
      const domain = urlObj.hostname.replace('www.', '');
      const path = urlObj.pathname.replace(/\//g, '_');

      // Create a base ID from domain and path
      const baseId = `${domain}${path}`.replace(/[^a-zA-Z0-9]/g, '_');

      // Add a timestamp to ensure uniqueness
      const timestamp = Date.now();

      // Combine everything into a valid ID
      return `site_${baseId}_${timestamp}`;
    } catch (error) {
      console.error('Error generating video ID:', error);
      // Fallback to a simpler ID generation
      const timestamp = Date.now();
      return `site_${timestamp}`;
    }
  };

  // Fetch YouTube video title
  const fetchYoutubeVideoTitle = async (videoId) => {
    try {
      // Use the YouTube API service to get video details
      const videoDetails = await getVideoDetails(videoId);
      return videoDetails ? videoDetails.title : null;
    } catch (error) {
      console.error('Error fetching video title:', error);
      return null;
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
        const title = await fetchYoutubeVideoTitle(videoId) || 'YouTube Video';
        // Store the video URL in localStorage to maintain state
        localStorage.setItem('current_video_url', inputUrl);
        setSelectedVideo({
          id: videoId,
          url: inputUrl,
          source: 'youtube',
          title: title,
          thumbnail: `https://img.youtube.com/vi/${videoId}/0.jpg`
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
  const handleSelectFromHistory = (historyItem) => {
    setUrl(historyItem.url);

    // Check if this is a Douyin URL that should use unified downloader
    if (isValidDouyinUrl(historyItem.url)) {
      const videoId = extractDouyinVideoId(historyItem.url);
      if (videoId) {
        setSelectedVideo({
          id: videoId,
          url: historyItem.url,
          source: 'douyin',
          title: 'Douyin Video',
          thumbnail: ''
        });
        setUrlType('douyin');
        setShowHistory(false);
        return;
      }
    }

    // Use original history item for non-Douyin URLs
    setSelectedVideo({
      id: historyItem.id,
      url: historyItem.url,
      source: historyItem.source,
      title: historyItem.title,
      thumbnail: historyItem.thumbnail || ''
    });
    setUrlType(historyItem.source);
    setShowHistory(false);
  };

  // Direct download function for Douyin videos
  const handleDouyinDirectDownload = async () => {
    if (!selectedVideo || !selectedVideo.url) return;

    setIsDouyinDownloading(true);
    setDouyinDownloadProgress(0);

    try {
      // Use the same download function as the main generate flow
      const videoUrl = await downloadDouyinVideo(
        selectedVideo.url,
        (progress) => {
          setDouyinDownloadProgress(progress);
        }
      );

      // Download completed successfully
      setIsDouyinDownloading(false);

      // Trigger file download
      try {
        const videoId = extractDouyinVideoId(selectedVideo.url);

        // Use the dedicated download endpoint that sets proper headers
        const downloadUrl = `http://localhost:3031/api/douyin-download-file/${videoId}`;

        // Create download link that will trigger proper download
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `${videoId}.mp4`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (downloadError) {
        console.error('[UnifiedUrlInput] Error downloading file:', downloadError);
        // Show user a message instead of navigating
        alert(`Download completed! File saved as: ${extractDouyinVideoId(selectedVideo.url)}.mp4`);
      }
    } catch (error) {
      console.error('Error downloading Douyin video:', error);
      setIsDouyinDownloading(false);
      setDouyinDownloadProgress(0);
      alert(`Download failed: ${error.message}`);
    }
  };

  // Get the appropriate icon based on URL type
  const getUrlIcon = () => {
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
  const getPlaceholderText = () => {
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
  const renderVideoPreview = () => {
    if (!selectedVideo || !selectedVideo.id) return null;

    switch (selectedVideo.source) {
      case 'youtube':
        return (
          <div className="selected-video-preview">
            <img
              src={`https://img.youtube.com/vi/${selectedVideo.id}/0.jpg`}
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
  const renderExamples = () => {
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

  return (
    <div className={`unified-url-input ${className || ''}`}>
      <div className="url-input-wrapper">
        <input
          type="text"
          value={url}
          onChange={handleUrlChange}
          placeholder={getPlaceholderText()}
          className="url-field"
          ref={inputRef}
        />
        {getUrlIcon()}

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
                        onError={(e) => {
                          e.target.src = `https://img.youtube.com/vi/${item.id}/0.jpg`;
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

      {renderVideoPreview()}
      {renderExamples()}

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
