import React, { useState } from 'react';
import { FiSearch } from 'react-icons/fi';
import { useTranslation } from 'react-i18next';
import useGeniusLyrics from '../hooks/useGeniusLyrics';

/**
 * Component for lyrics input and fetching
 */
const LyricsInputSection = ({ onLyricsReceived }) => {
  const { t } = useTranslation();
  const [artist, setArtist] = useState('');
  const [song, setSong] = useState('');


  // Use the Genius lyrics hook
  const { albumArtUrl, loading, cleaning, error, fetchLyrics } = useGeniusLyrics();

  // Handle fetching lyrics from Genius
  const handleFetchLyrics = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!artist || !song) {
      return;
    }

    try {
      // Always fetch fresh lyrics
      const result = await fetchLyrics(artist, song, false);

      if (result && result.lyrics) {
        // Pass only the lyrics to the parent component
        onLyricsReceived(result.lyrics);
      }
    } catch (err) {
      console.error('Error fetching lyrics:', err);
    }
  };

  // Prevent form submission
  const preventSubmit = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      return false;
    }
  };

  return (
    <div className="lyrics-input-section">
      <div className="lyrics-input-fields">
        <div className="lyrics-input-field">
          <label htmlFor="artist-input">{t('subtitlesInput.artist', 'Artist:')}</label>
          <input
            id="artist-input"
            type="text"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            onKeyDown={preventSubmit}
            placeholder={t('subtitlesInput.artistPlaceholder', 'Enter artist name')}
          />
        </div>
        <div className="lyrics-input-field">
          <label htmlFor="song-input">{t('subtitlesInput.song', 'Song:')}</label>
          <input
            id="song-input"
            type="text"
            value={song}
            onChange={(e) => setSong(e.target.value)}
            onKeyDown={preventSubmit}
            placeholder={t('subtitlesInput.songPlaceholder', 'Enter song title')}
          />
        </div>
        <div
          className={`fetch-lyrics-button ${(!artist || !song || loading) ? 'disabled' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!artist || !song || loading) return;
            handleFetchLyrics();
          }}
          style={{
            cursor: (!artist || !song || loading) ? 'not-allowed' : 'pointer',
            opacity: (!artist || !song || loading) ? 0.6 : 1,
            userSelect: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          role="button"
          tabIndex={(!artist || !song || loading) ? -1 : 0}
        >
          {loading ? t('subtitlesInput.fetching', 'Fetching...') : (
            <>
              <FiSearch />
              {t('subtitlesInput.fetch', 'Fetch')}
            </>
          )}
        </div>
      </div>

      {error && <div className="lyrics-error">{error}</div>}

      {cleaning && (
        <div className="lyrics-cleaning-message">
          <span className="cleaning-spinner"></span>
          {t('subtitlesInput.cleaning', 'Cleaning lyrics...')}
        </div>
      )}

      {albumArtUrl && (
        <div className="album-art-container">
          <img
            src={albumArtUrl}
            alt="Album Art"
            className="album-art"
          />
        </div>
      )}
    </div>
  );
};

export default LyricsInputSection;
