import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { searchYouTubeVideos, isOAuthEnabled } from '../../platform/desktopYoutubeService';
import { addSearchQueryToHistory, getSearchQueryHistory, clearSearchQueryHistory, formatTimestamp } from '../../utils/historyUtils';
import { activateOnKey } from '../../utils/a11y/activateOnKey';
import { youtubeSearchErrorToast } from './youtubeErrors';

const MIN_QUERY_LENGTH = 3;
const EMPTY_RESULTS = Object.freeze([]);

const useDebounce = (value, delay) => {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
};

const YoutubeSearchInput = ({ apiKeysSet = { youtube: false }, selectedVideo, setSelectedVideo, className }) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const historyDropdownRef = useRef(null);
  const inputRef = useRef(null);
  // Each search takes a token; only the newest token may publish results, errors or the spinner.
  const searchTokenRef = useRef(0);

  const cancelSearch = useCallback(() => {
    searchTokenRef.current += 1;
    setIsSearching(false);
  }, []);

  useEffect(() => () => { searchTokenRef.current += 1; }, []);

  const searchYouTube = useCallback(async (query) => {
    searchTokenRef.current += 1;
    const token = searchTokenRef.current;
    const isCurrent = () => searchTokenRef.current === token;
    setIsSearching(true);

    try {
      const results = await searchYouTubeVideos(query);
      if (!isCurrent()) return;
      setSearchResults(results);
      if (results.length === 0) {
        window.addToast(t('youtube.noResults', 'No results found.'), 'error', 5000);
      }
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Error searching YouTube:', error);
      const [message, duration] = youtubeSearchErrorToast(t, error, { oauth: isOAuthEnabled() });
      window.addToast(message, 'error', duration);
    } finally {
      if (isCurrent()) setIsSearching(false);
    }
  }, [t]);

  const debouncedSearchQuery = useDebounce(searchQuery, 500);

  // Load history on component mount
  useEffect(() => {
    setHistory(getSearchQueryHistory());
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

  // Search YouTube when query changes
  useEffect(() => {
    if (debouncedSearchQuery.length < MIN_QUERY_LENGTH) {
      cancelSearch();
      setSearchResults(EMPTY_RESULTS);
      return;
    }

    // Check authentication method and status
    if (!isOAuthEnabled() && !apiKeysSet.youtube) {
      cancelSearch();
      window.addToast(t('youtube.noApiKey', 'Please set your YouTube API key in the settings first.'), 'error', 5000);
      return;
    }

    // Add to search history if query is valid
    if (debouncedSearchQuery.trim().length >= MIN_QUERY_LENGTH) {
      addSearchQueryToHistory(debouncedSearchQuery);
      // Refresh history list
      setHistory(getSearchQueryHistory());
    }

    searchYouTube(debouncedSearchQuery);
  }, [debouncedSearchQuery, apiKeysSet.youtube, t, searchYouTube, cancelSearch]);

  // A query too short to search drops the in-flight search and its results at once.
  const updateSearchQuery = (value) => {
    setSearchQuery(value);
    if (value.length < MIN_QUERY_LENGTH) {
      cancelSearch();
      setSearchResults(EMPTY_RESULTS);
    }
  };

  const handleSearchChange = (e) => {
    updateSearchQuery(e.target.value);
  };

  // Handle search result selection
  const handleVideoSelect = (video) => {
    setSelectedVideo({
      ...video
    });
  };

  // Toggle history dropdown
  const toggleHistory = () => {
    setShowHistory(prev => !prev);
  };

  // Handle selecting a query from history
  const handleSelectFromHistory = (query) => {
    updateSearchQuery(query);
    setShowHistory(false);
    // Focus the input field
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  // Clear history
  const handleClearHistory = (e) => {
    e.stopPropagation();
    clearSearchQueryHistory();
    setHistory([]);
  };

  return (
    <div className={`youtube-search-input ${className || ''}`}>
      <div className="search-field-container">
        <div className="search-input-wrapper">
          <span className="material-symbols-rounded search-icon" style={{ fontSize: 18 }}>search</span>
          <input
            type="text"
            id="youtube-search-input"
            className="youtube-search-field"
            placeholder={t('youtube.searchPlaceholder', 'Enter video title...')}
            value={searchQuery}
            onChange={handleSearchChange}
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
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>schedule</span>
            </button>
          )}

          {searchQuery && (
            <button
              className="clear-search-btn"
              onClick={() => updateSearchQuery('')}
              aria-label={t('youtube.clearSearch', 'Clear search')}
            >
              <span aria-hidden="true" className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
            </button>
          )}

          {/* History dropdown */}
          {history.length > 0 && (
            <div className="history-dropdown" ref={historyDropdownRef} style={{ opacity: showHistory ? 1 : 0, pointerEvents: showHistory ? 'auto' : 'none' }}>
              <div className="history-header">
                <h4 className="history-title">{t('youtube.recentSearches', 'Recent Searches')}</h4>
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
                    key={`${item.query}-${index}`}
                    className="history-query-item"
                    onClick={() => handleSelectFromHistory(item.query)}
                    onKeyDown={activateOnKey}
                    role="button"
                    tabIndex={showHistory ? 0 : -1}
                  >
                    <span aria-hidden="true" className="material-symbols-rounded history-query-icon" style={{ fontSize: 16 }}>search</span>
                    <span className="history-query-text">{item.query}</span>
                    <span className="history-query-time">{formatTimestamp(item.timestamp)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="search-results">

        {isSearching && (
          <div className="searching-indicator">
            <div className="search-spinner"></div>
            <p>{t('youtube.searching', 'Searching...')}</p>
          </div>
        )}

        {!isSearching && searchResults.length > 0 && (
          searchResults.map(video => (
            <div
              key={video.id}
              className={`search-result-item ${selectedVideo?.id === video.id ? 'selected' : ''}`}
            >
              <div
                className="search-result-content"
                onClick={() => handleVideoSelect(video)}
                onKeyDown={activateOnKey}
                role="button"
                tabIndex={0}
                aria-pressed={selectedVideo?.id === video.id}
              >
                <div className="search-thumbnail-container">
                  <img
                    src={video.thumbnail}
                    alt={video.title}
                    className="search-result-thumbnail"
                  />
                </div>
                <div className="search-result-info">
                  <div className="search-result-title">{video.title}</div>
                  <div className="search-result-channel">{video.channel}</div>
                </div>
              </div>


            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default YoutubeSearchInput;
