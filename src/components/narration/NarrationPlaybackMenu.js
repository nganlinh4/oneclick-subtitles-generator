import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../../styles/narration/narrationPlaybackMenuRedesign.css';

/**
 * Narration Playback Menu component
 * Provides controls for playing narration voices with the video
 *
 * @param {Object} props - Component props
 * @param {Array} props.originalNarrations - Original narration audio files
 * @param {Array} props.translatedNarrations - Translated narration audio files
 * @param {Object} props.videoRef - Reference to the video element
 * @param {Function} props.getAudioUrl - Function to get audio URL from filename
 * @returns {JSX.Element} - Rendered component
 */
const NarrationPlaybackMenu = ({
  originalNarrations = [],
  translatedNarrations = [],
  videoRef,
  getAudioUrl
}) => {

  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [narrationSource, setNarrationSource] = useState('original'); // 'original' or 'translated'
  const [narrationVolume, setNarrationVolume] = useState(1.0); // 0 to 1
  const [videoVolume, setVideoVolume] = useState(1.0); // 0 to 1
  const [activeNarrations, setActiveNarrations] = useState([]);
  const [currentNarration, setCurrentNarration] = useState(null);

  // Refs for audio elements
  const audioRefs = useRef({});
  const menuRef = useRef(null);

  // Initialize active narrations based on selected source
  useEffect(() => {
    setActiveNarrations(narrationSource === 'original' ? originalNarrations : translatedNarrations);
  }, [narrationSource, originalNarrations, translatedNarrations]);

  // Update video volume when it changes
  useEffect(() => {
    if (videoRef && videoRef.current) {
      videoRef.current.volume = videoVolume;
    }
  }, [videoVolume, videoRef]);

  // Store audio durations
  const audioDurationsRef = useRef({});

  // Play a specific narration
  const playNarration = useCallback((narration, subtitleMidPoint) => {
    // Stop any currently playing narration
    if (currentNarration && audioRefs.current[currentNarration.id]) {
      audioRefs.current[currentNarration.id].pause();
    }

    // Set the current narration
    setCurrentNarration(narration);

    // Get or create audio element for this narration
    if (!audioRefs.current[narration.subtitle_id]) {
      const audioUrl = getAudioUrl(narration.filename);

      const audio = new Audio(audioUrl);

      // Set volume immediately
      audio.volume = narrationVolume;

      // Store the audio duration once it's loaded
      audio.addEventListener('loadedmetadata', () => {
        audioDurationsRef.current[narration.subtitle_id] = audio.duration;

        // Set volume again after metadata is loaded
        audio.volume = narrationVolume;
      });

      // Add error handling
      audio.addEventListener('error', (e) => {
        console.error(`Audio error for narration ${narration.subtitle_id}:`, e);
        console.error('Audio error code:', audio.error?.code);
        console.error('Audio error message:', audio.error?.message);
      });

      // Add play event listener
      audio.addEventListener('play', () => {
        // Event handler can be empty
      });

      audioRefs.current[narration.subtitle_id] = audio;
    }

    // Play the narration
    const audioElement = audioRefs.current[narration.subtitle_id];

    // Set volume again before playing
    audioElement.volume = narrationVolume;

    // If we know the audio duration, calculate the correct start time to align the middle
    // of the audio with the middle of the subtitle
    if (audioDurationsRef.current[narration.subtitle_id] && subtitleMidPoint && videoRef?.current) {
      const audioDuration = audioDurationsRef.current[narration.subtitle_id];
      const currentVideoTime = videoRef.current.currentTime;

      // Calculate how far we are from the subtitle midpoint
      const timeFromMidPoint = subtitleMidPoint - currentVideoTime;

      // Calculate where in the audio we should start playing
      // If timeFromMidPoint is positive, we're before the midpoint
      // If timeFromMidPoint is negative, we're after the midpoint
      const audioStartTime = (audioDuration / 2) - timeFromMidPoint;

      // Ensure the start time is within valid bounds
      if (audioStartTime >= 0 && audioStartTime < audioDuration) {
        audioElement.currentTime = audioStartTime;
      } else {
        audioElement.currentTime = 0;
      }
    } else {
      audioElement.currentTime = 0;
    }

    audioElement.play();
  }, [currentNarration, narrationVolume, getAudioUrl, videoRef]);

  // Handle video timeupdate to trigger narration playback
  useEffect(() => {
    const handleTimeUpdate = () => {
      if (!isPlaying || !videoRef?.current) return;

      const currentTime = videoRef.current.currentTime;

      // Find narrations that should be playing at the current time
      activeNarrations.forEach(narration => {
        const subtitle = narration.subtitle || {};
        const start = parseFloat(subtitle.start) || 0;
        const end = parseFloat(subtitle.end) || 0;

        // Calculate the middle point of the subtitle
        const subtitleMidPoint = (start + end) / 2;

        // Get or estimate the narration duration
        let narrationDuration = audioDurationsRef.current[narration.subtitle_id];
        if (!narrationDuration) {
          // If we don't have the duration yet, create a temporary audio element to get it
          const tempAudio = new Audio(getAudioUrl(narration.filename));
          tempAudio.addEventListener('loadedmetadata', () => {
            // Store the actual duration for future use
            audioDurationsRef.current[narration.subtitle_id] = tempAudio.duration;
          });
          // Use subtitle duration as fallback until we know the actual audio duration
          narrationDuration = end - start;
        }

        // Calculate when to start playing to align the middle of the narration with the middle of the subtitle
        const startPlay = subtitleMidPoint - (narrationDuration / 2);
        const endPlay = subtitleMidPoint + (narrationDuration / 2);

        // Check if current time is within the play window
        if (currentTime >= startPlay && currentTime <= endPlay) {
          // If we're not already playing this narration, play it
          if (currentNarration?.id !== narration.subtitle_id) {
            playNarration(narration, subtitleMidPoint);
          }
        }
      });
    };

    // Add event listener to video
    if (videoRef && videoRef.current && isPlaying) {
      const video = videoRef.current; // Store reference to avoid closure issues
      video.addEventListener('timeupdate', handleTimeUpdate);

      return () => {
        // Clean up event listener
        video.removeEventListener('timeupdate', handleTimeUpdate);
      };
    }
  }, [isPlaying, activeNarrations, currentNarration, videoRef, getAudioUrl, playNarration]);

  // Toggle narration playback
  const togglePlayback = () => {
    if (isPlaying) {
      // Stop playback
      setIsPlaying(false);

      // Pause any playing narration
      if (currentNarration && audioRefs.current[currentNarration.id]) {
        audioRefs.current[currentNarration.id].pause();
      }

      setCurrentNarration(null);
    } else {
      // Start playback
      setIsPlaying(true);
    }
  };

  // Toggle menu open/closed
  const toggleMenu = () => {
    setIsOpen(prevState => !prevState);
  };

  // Handle click outside to close menu
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    // Only add the event listener when the menu is open
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      // Add escape key listener
      const handleEscKey = (event) => {
        if (event.key === 'Escape') {
          setIsOpen(false);
        }
      };
      document.addEventListener('keydown', handleEscKey);

      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleEscKey);
      };
    }
  }, [isOpen]);

  // Update all audio volumes when narration volume changes
  useEffect(() => {
    Object.values(audioRefs.current).forEach(audio => {
      audio.volume = narrationVolume;
    });
  }, [narrationVolume]);



  return (
    <div className={`narration-playback-container ${isOpen ? 'open' : ''}`} ref={menuRef}>
      <button
        className="narration-playback-toggle"
        onClick={toggleMenu}
        title={t('narration.playbackMenu', 'Narration Playback')}
        style={{ backgroundColor: '#2196F3', color: 'white', fontSize: '20px', fontWeight: 'bold' }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>mic</span>
        N
      </button>

      <div className="narration-playback-menu" style={{ zIndex: 9999 }}>
        <div className="menu-header">
          <h3>{t('narration.playbackTitle', 'Narration')}</h3>
          <button
            className="close-menu"
            onClick={() => setIsOpen(false)}
            style={{
              padding: '8px',
              backgroundColor: 'rgba(0,0,0,0.1)',
              borderRadius: '50%',
              cursor: 'pointer',
              border: 'none'
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
          </button>
        </div>

        <div className="menu-content" style={{ padding: '16px', backgroundColor: '#fff', color: '#000' }}>
          {/* Playback Controls */}
          <div className="playback-controls">
            <button
              className={`pill-button ${isPlaying ? 'error' : 'primary'}`}
              onClick={togglePlayback}
              disabled={!activeNarrations.length}
            >
              {isPlaying ? (
                <>
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>pause</span>
                  {t('narration.stopPlayback', 'Stop')}
                </>
              ) : (
                <>
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>play_arrow</span>
                  {t('narration.startPlayback', 'Play')}
                </>
              )}
            </button>
          </div>

          {/* Narration Source Selection */}
          <div className="narration-source">
            <label>{t('narration.narrationSource', 'Source')}:</label>
            <div className="radio-pill-group">
              <div className="radio-pill">
                <input
                  type="radio"
                  id="source-original-narration"
                  name="narration-source"
                  checked={narrationSource === 'original'}
                  onChange={() => setNarrationSource('original')}
                  disabled={!originalNarrations.length}
                />
                <label htmlFor="source-original-narration">
                  {t('narration.original', 'Original')}
                </label>
              </div>
              <div className="radio-pill">
                <input
                  type="radio"
                  id="source-translated-narration"
                  name="narration-source"
                  checked={narrationSource === 'translated'}
                  onChange={() => setNarrationSource('translated')}
                  disabled={!translatedNarrations.length}
                />
                <label htmlFor="source-translated-narration">
                  {t('narration.translated', 'Translated')}
                </label>
              </div>
            </div>
          </div>

          {/* Volume Controls */}
          <div className="volume-controls">
            <div className="volume-control">
              <label htmlFor="narration-volume">
                <span className="icon-label-container">
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>mic</span>
                  <span>{t('narration.narrationVolume', 'Narration')}:</span>
                </span>
              </label>
              <div className="slider-container">
                <input
                  type="range"
                  id="narration-volume"
                  min="0"
                  max="1"
                  step="0.01"
                  value={narrationVolume}
                  onChange={(e) => setNarrationVolume(parseFloat(e.target.value))}
                  className="range-slider"
                />
                <div className="slider-value">{Math.round(narrationVolume * 100)}%</div>
              </div>
            </div>

            <div className="volume-control">
              <label htmlFor="video-volume">
                <span className="icon-label-container">
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>volume_up</span>
                  <span>{t('narration.videoVolume', 'Video Audio')}:</span>
                </span>
              </label>
              <div className="slider-container">
                <input
                  type="range"
                  id="video-volume"
                  min="0"
                  max="1"
                  step="0.01"
                  value={videoVolume}
                  onChange={(e) => setVideoVolume(parseFloat(e.target.value))}
                  className="range-slider"
                />
                <div className="slider-value">{Math.round(videoVolume * 100)}%</div>
              </div>
            </div>
          </div>

          {/* Status */}
          <div className="narration-status">
            {activeNarrations.length === 0 ? (
              <div className="status-message warning">
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>warning</span>
                {narrationSource === 'original'
                  ? t('narration.noOriginalNarrations', 'No original narrations available')
                  : t('narration.noTranslatedNarrations', 'No translated narrations available')}
              </div>
            ) : (
              <div className="status-message info">
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>info</span>
                {t('narration.narrationReady', 'Narration ready for playback')}
                <div className="narration-count">
                  {t('narration.narrationCount', '{{count}} narrations available', { count: activeNarrations.length })}
                </div>
              </div>
            )}
          </div>

          {/* Extra close button at the bottom */}
          <button
            className="pill-button error close-menu-button"
            onClick={() => setIsOpen(false)}
            style={{
              marginTop: '16px',
              width: '100%',
              backgroundColor: '#f44336',
              color: 'white',
              padding: '10px',
              fontSize: '16px',
              fontWeight: 'bold',
              border: 'none',
              borderRadius: '20px',
              cursor: 'pointer'
            }}
          >
            {t('narration.closeMenu', 'Close Menu')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NarrationPlaybackMenu;
