import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../config';

/**
 * Custom hook for fetching lyrics from Genius API
 * @returns {Object} - Lyrics fetching state and functions
 */
const useGeniusLyrics = () => {
  const { t } = useTranslation();
  const [lyrics, setLyrics] = useState('');
  const [albumArtUrl, setAlbumArtUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Clean lyrics by removing square-bracketed lines, blank lines, and header content
   * @param {string} lyrics - Raw lyrics to clean
   * @returns {Promise<string>} - Cleaned lyrics
   */
  const cleanLyrics = async (lyrics) => {
    try {
      setCleaning(true);

      // Split lyrics into lines
      const lines = lyrics.split('\n');

      // Initialize startIndex
      let startIndex = 0;

      // Check if the first line contains "Lyrics" and modify it to keep the content after "Lyrics"
      if (lines.length > 0) {
        const line = lines[0];
        const lyricsIndex = line.indexOf("Lyrics");

        if (lyricsIndex !== -1) {
          // Found "Lyrics" in the first line
          // Keep only the content after "Lyrics"
          const contentAfterLyrics = line.substring(lyricsIndex + "Lyrics".length).trim();

          // Replace the first line with just the content after "Lyrics"
          if (contentAfterLyrics) {
            lines[0] = contentAfterLyrics;
          } else {
            // If there's nothing after "Lyrics", remove this line
            lines.splice(0, 1);
          }
        }
      }

      // Now find the first line with square brackets in the modified lines array
      let firstBracketLineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();
        if (trimmedLine.includes('[') && trimmedLine.includes(']')) {
          firstBracketLineIndex = i;
          break;
        }
      }

      // If we found a line with brackets, update the start index
      if (firstBracketLineIndex > 0) {
        startIndex = firstBracketLineIndex + 1;
      } else if (firstBracketLineIndex === 0) {
        startIndex = 1;
      } else {
        startIndex = 0;
      }

      // Filter out lines with square brackets and empty lines
      const cleanedLines = [];
      for (let i = startIndex; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();

        // Skip empty lines
        if (!trimmedLine) continue;

        // Skip lines that contain square brackets
        if (trimmedLine.includes('[') && trimmedLine.includes(']')) continue;

        cleanedLines.push(trimmedLine);
      }

      // Join the cleaned lines back together
      return cleanedLines.join('\n');
    } catch (err) {
      console.error('Error cleaning lyrics:', err);
      // Return original lyrics if cleaning fails
      return lyrics;
    } finally {
      setCleaning(false);
    }
  };

  /**
   * Fetch lyrics from Genius API
   * @param {string} artist - Artist name
   * @param {string} song - Song name
   * @param {boolean} force - Force refetch even if cached
   * @returns {Promise<Object>} - Lyrics and album art URL
   */
  const fetchLyrics = async (artist, song, force = false) => {
    if (!artist || !song) {
      setError(t('lyrics.genius.artistAndSongRequired'));
      return null;
    }

    try {
      setError(null);
      setLoading(true);

      const response = await fetch(`${API_BASE_URL}/lyrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artist,
          song,
          force
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch lyrics');
      }

      const data = await response.json();

      if (data.lyrics) {
        // First set the raw lyrics and album art
        setLyrics(data.lyrics);
        setAlbumArtUrl(data.albumArtUrl || '');

        // Then clean the lyrics with our local function
        const cleanedLyrics = await cleanLyrics(data.lyrics);

        // Update with cleaned lyrics
        setLyrics(cleanedLyrics);

        // Return the data with cleaned lyrics
        return {
          ...data,
          lyrics: cleanedLyrics
        };
      }

      return null;
    } catch (err) {
      // Check for specific server-side errors and translate them
      let translatedMessage = err.message;
      if (err.message.includes('Genius API key not set')) {
        translatedMessage = t('lyrics.genius.apiKeyNotSet');
      } else {
        translatedMessage = `${t('lyrics.genius.lyricsFetchFailed')}: ${err.message}`;
      }
      setError(translatedMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Clear the current lyrics and album art
   */
  const clearLyrics = () => {
    setLyrics('');
    setAlbumArtUrl('');
  };

  return {
    lyrics,
    albumArtUrl,
    loading,
    cleaning,
    error,
    fetchLyrics,
    clearLyrics
  };
};

export default useGeniusLyrics;
