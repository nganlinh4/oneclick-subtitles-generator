import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { addYoutubeUrlToHistory, getYoutubeUrlHistory, clearYoutubeUrlHistory, formatTimestamp } from '../../utils/historyUtils';
import { getVideoDetails } from '../../services/youtubeApiService';

const YoutubeUrlInput = ({ setSelectedVideo, selectedVideo, className }) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const historyDropdownRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (selectedVideo) {
      setVideoTitle(selectedVideo.title || 'YouTube Video');

      // Add to history when a video is selected
      if (selectedVideo.source === 'youtube' && selectedVideo.id) {
        addYoutubeUrlToHistory(selectedVideo);
        // Refresh history list
        setHistory(getYoutubeUrlHistory());
      }
    }
  }, [selectedVideo]);

  // Load history on component mount
  useEffect(() => {
    setHistory(getYoutubeUrlHistory());
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

  const isValidYoutubeUrl = (url) => {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})(\S*)?$/;
    return youtubeRegex.test(url);
  };

  const extractVideoId = (url) => {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[7].length === 11) ? match[7] : null;
  };

  const fetchVideoTitle = async (videoId) => {
    try {
      // Use the YouTube API service to get video details
      const videoDetails = await getVideoDetails(videoId);
      return videoDetails ? videoDetails.title : null;
    } catch (error) {
      console.error('Error fetching video title:', error);

      // Check for quota exceeded error
      if (error.message.includes('quota exceeded')) {
        window.addToast(error.message, 'error', 8000);
      }

      return null;
    }
  };

  const handleUrlChange = async (e) => {
    const url = e.target.value.trim();
    setUrl(url);

    if (isValidYoutubeUrl(url)) {
      localStorage.removeItem('current_file_url');

      const videoId = extractVideoId(url);
      if (videoId) {
        const title = await fetchVideoTitle(videoId) || 'YouTube Video';
        // Store the video URL in localStorage to maintain state
        localStorage.setItem('current_video_url', url);
        setSelectedVideo({
          id: videoId,
          url: url,
          source: 'youtube',
          title: title,
          thumbnail: `https://img.youtube.com/vi/${videoId}/0.jpg`
        });
      }
    } else {
      setSelectedVideo(null);
      // Clear the video URL from localStorage
      localStorage.removeItem('current_video_url');
    }
  };

  // Toggle history dropdown
  const toggleHistory = () => {
    setShowHistory(prev => !prev);
  };

  // Handle selecting a video from history
  const handleSelectFromHistory = (historyItem) => {
    setUrl(historyItem.url);
    setSelectedVideo({
      id: historyItem.id,
      url: historyItem.url,
      source: 'youtube',
      title: historyItem.title,
      thumbnail: historyItem.thumbnail
    });
    setShowHistory(false);
  };

  // Clear history
  const handleClearHistory = (e) => {
    e.stopPropagation();
    clearYoutubeUrlHistory();
    setHistory([]);
  };

  return (
    <div className={`youtube-url-input ${className || ''}`}>
      <div className="url-input-wrapper">
        <span className="material-symbols-rounded youtube-icon" style={{ fontSize: '24px' }}>smart_display</span>
        <input
          type="text"
          value={url}
          onChange={handleUrlChange}
          placeholder={t('youtubeUrlInput.placeholder', 'Enter YouTube URL (e.g., youtube.com/watch?v=...)')}
          className="youtube-url-field"
          ref={inputRef}
        />

        {/* History button */}
        {history.length > 0 && (
          <button
            type="button"
            className="history-button"
            onClick={toggleHistory}
            aria-label={t('common.history', 'History')}
            title={t('common.history', 'History')}
          >
            <span className="material-symbols-rounded">schedule</span>
          </button>
        )}

        {url && (
          <button
            type="button"
            className="clear-url-btn"
            onClick={() => {
              setUrl('');
              setSelectedVideo(null);
              // Also clear the video URL from localStorage
              localStorage.removeItem('current_video_url');
            }}
            aria-label="Clear input"
          >
            <span className="material-symbols-rounded">close</span>
          </button>
        )}

        {/* History dropdown */}
        {history.length > 0 && (
          <div className="history-dropdown" ref={historyDropdownRef} style={{ opacity: showHistory ? 1 : 0, pointerEvents: showHistory ? 'auto' : 'none' }}>
            <div className="history-header">
              <h4 className="history-title">{t('youtube.recentVideos', 'Recent Videos')}</h4>
              <button
                className="clear-history-btn"
                onClick={handleClearHistory}
              >
                {t('common.clearAll', 'Clear All')}
              </button>
            </div>
            <div className="history-list">
              {history.map((item, index) => (
                <div
                  key={`${item.id}-${index}`}
                  className="history-item"
                  onClick={() => handleSelectFromHistory(item)}
                >
                  <div className="history-item-content">
                    <img
                      src={item.thumbnail}
                      alt={item.title}
                      className="history-thumbnail"
                      onError={(e) => {
                        e.target.src = `https://img.youtube.com/vi/${item.id}/0.jpg`;
                      }}
                    />
                    <div className="history-item-info">
                      <div className="history-item-title">{item.title}</div>
                      <div className="history-item-meta">
                        <span className="history-item-id">{item.id}</span>
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


      {!selectedVideo && (
        <div className="youtube-instructions-container">
          <div className="youtube-instructions-row">
            <div className="youtube-instructions-col">
              <h4>{t('youtubeUrlInput.examplesTitle', 'Supported URL formats:')}</h4>
              <ul>
                <li>{t('youtubeUrlInput.example1', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')}</li>
                <li>{t('youtubeUrlInput.example2', 'https://youtu.be/dQw4w9WgXcQ')}</li>
                <li>{t('youtubeUrlInput.example3', 'youtube.com/watch?v=dQw4w9WgXcQ')}</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {selectedVideo && selectedVideo.id && (
        <>
          <div className="selected-video-preview">
            <img
              src={`https://img.youtube.com/vi/${selectedVideo.id}/0.jpg`}
              alt={videoTitle}
              className="thumbnail"
            />
            <div className="video-info">
              <h3 className="video-title">{videoTitle}</h3>
              <p className="video-id">{t('youtubeUrlInput.videoId', 'Video ID:')} <span className="video-id-value">{selectedVideo.id}</span></p>
            </div>
          </div>


        </>
      )}
    </div>
  );
};

export default YoutubeUrlInput;