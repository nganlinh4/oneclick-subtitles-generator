import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useGeniusLyrics from '../hooks/useGeniusLyrics';
import { showErrorToast, showInfoToast } from '../utils/toastUtils';

/**
 * Component for lyrics input and fetching
 */
const LyricsInputSection = ({ onLyricsReceived }) => {
  const { t } = useTranslation();
  const [artist, setArtist] = useState('');
  const [song, setSong] = useState('');

  // Load cached values when component mounts
  useEffect(() => {
    const cachedArtist = localStorage.getItem('cached_lyrics_artist');
    const cachedSong = localStorage.getItem('cached_lyrics_song');

    if (cachedArtist) setArtist(cachedArtist);
    if (cachedSong) setSong(cachedSong);
  }, []);

  // Save values to localStorage when they change
  useEffect(() => {
    if (artist) localStorage.setItem('cached_lyrics_artist', artist);
  }, [artist]);

  useEffect(() => {
    if (song) localStorage.setItem('cached_lyrics_song', song);
  }, [song]);

  // Use the Genius lyrics hook
  const { albumArtUrl, loading, cleaning, error, fetchLyrics } = useGeniusLyrics();

  // Dispatch toast notifications for error and cleaning states
  useEffect(() => {
    if (error) {
      showErrorToast(error);
    }
  }, [error]);

  useEffect(() => {
    if (cleaning) {
      showInfoToast(t('subtitlesInput.cleaning', 'Cleaning lyrics...'));
    }
  }, [cleaning]);

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
        // Pass the lyrics, album art, and song name to the parent component
        onLyricsReceived(result.lyrics, result.albumArtUrl || '', song);
      }
    } catch (err) {
      console.error('Error fetching lyrics:', err);
    }
  };

  // Handle Enter key press to trigger fetch
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Only trigger fetch if both fields have values and not currently loading
      if (artist && song && !loading) {
        handleFetchLyrics();
      }
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
            onKeyDown={handleKeyDown}
            placeholder={t('subtitlesInput.artistPlaceholder', 'Enter artist name')}
            autoComplete="off"
          />
        </div>
        <div className="lyrics-input-field">
          <label htmlFor="song-input">{t('subtitlesInput.song', 'Song:')}</label>
          <input
            id="song-input"
            type="text"
            value={song}
            onChange={(e) => setSong(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('subtitlesInput.songPlaceholder', 'Enter song title')}
            autoComplete="off"
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
              <span className="material-symbols-rounded">search</span>
              {t('subtitlesInput.fetch', 'Fetch')}
            </>
          )}
        </div>
      </div>

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
