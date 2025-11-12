import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import MaterialSwitch from '../common/MaterialSwitch';
import LoadingIndicator from '../common/LoadingIndicator';
import '../../styles/common/material-switch.css';
import {
  startYoutubeVideoDownload,
  checkDownloadStatus,
  extractYoutubeVideoId
} from '../../utils/videoDownloader';
import { renderSubtitlesToVideo, downloadVideo } from '../../utils/videoUtils';
import { convertTimeStringToSeconds } from '../../utils/vttUtils';
import SubtitleSettings from '../SubtitleSettings';
import VideoTopsideButtons from './VideoTopsideButtons';
import VideoBottomControls from './VideoBottomControls';
import SeekIndicator from './SeekIndicator';
// Narration settings now integrated into the translation section
import '../../styles/VideoPreview.css';
import '../../styles/narration/index.css';
import { SERVER_URL } from '../../config';
import useVideoSeekControls from '../../hooks/useVideoSeekControls';

const VideoPreview = ({ currentTime, setCurrentTime, setDuration, videoSource, fileType, onSeek, translatedSubtitles, subtitlesArray, onVideoUrlReady, onReferenceAudioChange, onRenderVideo, useCookiesForDownload = true }) => {
  const { t } = useTranslation();
  const videoRef = useRef(null);
  const videoContainerRef = useRef(null); // Ref for the main video container
  const lastBlobUrlRef = useRef(null);

  const handleSeek = (direction) => {
    setSeekDirection(direction);
    setShowSeekIndicator(true);
    setTimeout(() => setShowSeekIndicator(false), 1000);
  };

  useVideoSeekControls(videoRef, handleSeek);

  const seekLockRef = useRef(false);
  const lastTimeUpdateRef = useRef(0); // Track last time update to throttle updates
  const lastPlayStateRef = useRef(false); // Track last play state to avoid redundant updates
  const lastTouchTimeRef = useRef(0);
  // isFullscreen state is set but not directly used in rendering - used for event handling
  const [isFullscreen, setIsFullscreen] = useState(false); // Track fullscreen state
  const [videoUrl, setVideoUrl] = useState('');
  const [optimizedVideoUrl, setOptimizedVideoUrl] = useState('');
  const [optimizedVideoInfo, setOptimizedVideoInfo] = useState(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [isAudioDownloading, setIsAudioDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [videoId, setVideoId] = useState(null);
  const [downloadCheckInterval, setDownloadCheckInterval] = useState(null);
  const [isRenderingVideo, setIsRenderingVideo] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [isRefreshingNarration, setIsRefreshingNarration] = useState(false); // Track narration refresh state
  const [isVideoHovered, setIsVideoHovered] = useState(false); // Track video hover state for showing controls

  // Custom video control states
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showCustomControls, setShowCustomControls] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  const dragTimeRef = useRef(0);
  const [isVolumeSliderVisible, setIsVolumeSliderVisible] = useState(false);
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isSpeedMenuVisible, setIsSpeedMenuVisible] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideControlsTimeoutRef = useRef(null);
  const [bufferedProgress, setBufferedProgress] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  // Native track subtitles disabled - using only custom subtitle display
  const [useOptimizedPreview, setUseOptimizedPreview] = useState(() => {
    return localStorage.getItem('use_optimized_preview') === 'true';
  });
  const [showSeekIndicator, setShowSeekIndicator] = useState(false);
  const [seekDirection, setSeekDirection] = useState('');
  const [isCompactMode, setIsCompactMode] = useState(false);

  // Listen for changes to the optimized preview setting from Settings modal
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'use_optimized_preview') {
        setUseOptimizedPreview(e.newValue === 'true');
      }
    };

    // Listen for immediate custom event from settings save
    const handleCustomEvent = (e) => {
      console.log('[VideoPreview] Received immediate optimized preview change:', e.detail.value);
      setUseOptimizedPreview(e.detail.value);
    };

    // Listen for storage events (changes from other tabs/windows)
    window.addEventListener('storage', handleStorageChange);

    // Listen for immediate custom event (same tab changes)
    window.addEventListener('optimizedPreviewChanged', handleCustomEvent);

    // Also check for changes periodically as fallback
    const checkInterval = setInterval(() => {
      const currentValue = localStorage.getItem('use_optimized_preview') === 'true';
      setUseOptimizedPreview(prev => {
        if (prev !== currentValue) {
          console.log('[VideoPreview] Optimized preview setting changed (periodic check):', currentValue);
          return currentValue;
        }
        return prev;
      });
    }, 500); // Check every 500ms

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('optimizedPreviewChanged', handleCustomEvent);
      clearInterval(checkInterval);
    };
  }, []);

  // Listen for video volume changes from narration menu
  useEffect(() => {
    const handleVideoVolumeChange = (event) => {
      if (event.detail && typeof event.detail.volume === 'number') {
        const newVolume = event.detail.volume;
        setVolume(newVolume);
        if (videoRef.current) {
          videoRef.current.volume = newVolume;
          const newMuted = newVolume <= 0;
          if (isMuted !== newMuted) {
            videoRef.current.muted = newMuted;
            setIsMuted(newMuted);
          }
        }
      }
    };

    window.addEventListener('video-volume-change', handleVideoVolumeChange);

    return () => {
      window.removeEventListener('video-volume-change', handleVideoVolumeChange);
    };
  }, [isMuted]);

  // Detect compact mode based on video height
  useEffect(() => {
    const checkCompactMode = () => {
      if (videoRef.current) {
        const height = videoRef.current.offsetHeight;
        setIsCompactMode(height < 400);
      }
    };

    // Check on video load
    const videoElement = videoRef.current;
    if (videoElement) {
      videoElement.addEventListener('loadedmetadata', checkCompactMode);
      videoElement.addEventListener('resize', checkCompactMode);
    }

    // Also check periodically in case of dynamic resizing
    const interval = setInterval(checkCompactMode, 1000);

    return () => {
      if (videoElement) {
        videoElement.removeEventListener('loadedmetadata', checkCompactMode);
        videoElement.removeEventListener('resize', checkCompactMode);
      }
      clearInterval(interval);
    };
  }, []);

  // State for custom subtitle display
  const [currentSubtitleText, setCurrentSubtitleText] = useState('');

  // Native track subtitles disabled - using only custom subtitle display

  const [subtitleSettings, setSubtitleSettings] = useState(() => {
    // Try to load settings from localStorage
    const savedSettings = localStorage.getItem('subtitle_settings');
    if (savedSettings) {
      try {
        return JSON.parse(savedSettings);
      } catch (e) {
        console.error('Error parsing saved subtitle settings:', e);
      }
    }

    // Default settings if nothing is saved
    return {
      fontFamily: 'Google Sans, sans-serif',
      fontSize: '24',
      fontWeight: '500',
      position: '90', // Now a percentage value from 0 (top) to 100 (bottom)
      boxWidth: '80',
      backgroundColor: '#000000',
      opacity: '0.4',
      textColor: '#ffffff',
      showTranslatedSubtitles: false,
      backgroundRadius: '16',
      textShadow: true,
      fontVariationSettings: '"ROND" 100'
    };
  });
  // We track play state in lastPlayStateRef instead of using state to avoid unnecessary re-renders

  // Process the video URL (download if it's YouTube)
  const processVideoUrl = useCallback(async (url) => {


    // Reset states
    setError('');
    setIsLoaded(false);

    // Check if it's a YouTube URL
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      try {
        // Don't set downloading state to true until we know we need to download
        // This prevents the downloading UI from showing unnecessarily
        setDownloadProgress(0);

        // Store the URL for future use
        localStorage.setItem('current_video_url', url);

        // Extract video ID (used by the download process internally)
        extractYoutubeVideoId(url);

        // Start the download process but don't wait for it to complete
        const id = startYoutubeVideoDownload(url, false, useCookiesForDownload);
        setVideoId(id);

        // Check initial status - it might already be complete if cached
        const initialStatus = checkDownloadStatus(id);
        if (initialStatus.status === 'completed') {
          setVideoUrl(initialStatus.url);
          setIsDownloading(false);
        } else if (initialStatus.status === 'downloading') {
          // Only set downloading state to true if we're actually downloading
          setIsDownloading(true);
          setDownloadProgress(initialStatus.progress || 1); // Set to at least 1% to show progress
        }
      } catch (err) {
        console.error('Error starting YouTube video download:', err);
        setError(t('preview.videoError', `Error loading video: ${err.message}`));
        setIsDownloading(false);
      }
    } else {
      // Not a YouTube URL, use directly
      setVideoUrl(url);
    }
  }, [t, setError, setIsLoaded, setIsDownloading, setDownloadProgress, setVideoId, setVideoUrl, useCookiesForDownload]);

  // Initialize video source
  useEffect(() => {
    const loadVideo = async () => {
      // Reset video state when source changes
      setIsLoaded(false);
      setVideoUrl('');
      setOptimizedVideoUrl('');
      setError('');
      setOptimizedVideoInfo(null); // Reset optimized video info
      setIsDownloading(false); // Reset downloading state
      setDownloadProgress(0); // Reset download progress

      // Clear narration data when video source changes
      // Only log in development mode
      if (process.env.NODE_ENV === 'development') {

      }
      window.originalNarrations = [];
      window.translatedNarrations = [];
      localStorage.removeItem('originalNarrations');
      localStorage.removeItem('translatedNarrations');

      // Dispatch event to notify other components that narrations have been cleared
      const event = new CustomEvent('narrations-updated', {
        detail: {
          source: 'original',
          narrations: []
        }
      });
      window.dispatchEvent(event);

      const translatedEvent = new CustomEvent('narrations-updated', {
        detail: {
          source: 'translated',
          narrations: []
        }
      });
      window.dispatchEvent(translatedEvent);

      if (!videoSource) {
        // Don't show error message - SRT-only mode will be activated in App.js
        return;
      }

      // Only log in development mode
      if (process.env.NODE_ENV === 'development') {

      }

      // If it's a blob URL (from file upload), use it directly
      if (videoSource.startsWith('blob:')) {
        // Only log in development mode
        if (process.env.NODE_ENV === 'development') {

        }
        setVideoUrl(videoSource);

        // Check if we have an optimized version in localStorage
        try {
          const splitResult = JSON.parse(localStorage.getItem('split_result') || '{}');
          const lastOptimizationTimestamp = localStorage.getItem('last_optimization_timestamp');

          // For blob URLs, we'll use the most recent optimization result
          // since blob URLs don't contain filename information
          if (splitResult.optimized && splitResult.optimized.video && lastOptimizationTimestamp) {
            // Check if this optimization is recent (within last 5 minutes)
            const optimizationAge = Date.now() - parseInt(lastOptimizationTimestamp);
            const fiveMinutes = 5 * 60 * 1000;

            if (optimizationAge < fiveMinutes) {
              const optimizedUrl = `${SERVER_URL}${splitResult.optimized.video}`;
              // Using recent optimization result for blob URL
              setOptimizedVideoUrl(optimizedUrl);

              // Store the optimization info
              setOptimizedVideoInfo({
                resolution: splitResult.optimized.resolution || '360p',
                fps: splitResult.optimized.fps || 1,
                width: splitResult.optimized.width,
                height: splitResult.optimized.height
              });
            } else {
              // Optimization result too old, clearing
              setOptimizedVideoUrl('');
              setOptimizedVideoInfo(null);
            }
          } else {
            // No valid optimization result found
            setOptimizedVideoUrl('');
            setOptimizedVideoInfo(null);
          }
        } catch (error) {
          console.error('Error parsing split result from localStorage:', error);
          setOptimizedVideoUrl('');
          setOptimizedVideoInfo(null);
        }
        return;
      }

      // If it's a YouTube URL, handle download
      if (videoSource.includes('youtube.com') || videoSource.includes('youtu.be')) {
        await processVideoUrl(videoSource);
        return;
      }

      // For any other URL, try to use it directly
      setVideoUrl(videoSource);

      // Check for optimized version for all video types
      try {
        const splitResult = JSON.parse(localStorage.getItem('split_result') || '{}');
        const lastOptimizationTimestamp = localStorage.getItem('last_optimization_timestamp');

        if (splitResult.optimized && splitResult.optimized.video && lastOptimizationTimestamp) {
          // Check if this optimization is recent (within last 5 minutes)
          const optimizationAge = Date.now() - parseInt(lastOptimizationTimestamp);
          const fiveMinutes = 5 * 60 * 1000;

          if (optimizationAge < fiveMinutes) {
            const optimizedUrl = `${SERVER_URL}${splitResult.optimized.video}`;
            // Using recent optimization result for regular URL
            setOptimizedVideoUrl(optimizedUrl);

            // Store the optimization info
            setOptimizedVideoInfo({
              resolution: splitResult.optimized.resolution || '360p',
              fps: splitResult.optimized.fps || 1,
              width: splitResult.optimized.width,
              height: splitResult.optimized.height
            });
          }
        }
      } catch (error) {
        console.error('Error checking optimization for regular URL:', error);
      }
    };

    loadVideo();
  }, [videoSource, t, processVideoUrl]);

  // Notify parent component when videoUrl changes AND mirror as blob to act like uploaded
  useEffect(() => {
    const urlToUse = useOptimizedPreview && optimizedVideoUrl ? optimizedVideoUrl : videoUrl;
    if (!urlToUse) return;

    // Early notify with the actual player URL
    if (onVideoUrlReady) {
      onVideoUrlReady(urlToUse);
    }

    // Also create a blob/object URL so downstream (waveform, processors) can treat it like an upload
    (async () => {
      try {
        // If already a blob/object URL, persist and notify
        if (urlToUse.startsWith('blob:')) {
          localStorage.setItem('current_file_url', urlToUse);
          if (onVideoUrlReady) onVideoUrlReady(urlToUse);
          return;
        }

        // Check if this is an external URL that will cause CORS issues
        const isExternalUrl = (urlToUse.startsWith('http://') || urlToUse.startsWith('https://')) &&
                            !urlToUse.startsWith('http://localhost') &&
                            !urlToUse.startsWith('http://127.0.0.1');

        if (isExternalUrl) {
          // For external URLs, skip blob conversion to avoid CORS errors
          console.log('[VideoPreview] Skipping blob conversion for external URL to avoid CORS');
          // Still notify with the original URL for components that can handle it
          localStorage.setItem('current_file_url', urlToUse);
          if (onVideoUrlReady) onVideoUrlReady(urlToUse);
          return;
        }

        // Convert server URL to blob to avoid CORS/decoding issues (only for local URLs)
        const resp = await fetch(urlToUse, { cache: 'no-cache', mode: 'cors' });
        if (!resp.ok) throw new Error(`Failed to fetch video for blob: ${resp.status}`);
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        localStorage.setItem('current_file_url', objectUrl);
        // Expose blob in a global map keyed by its object URL for downstream reuse
        if (!window.__videoBlobMap) window.__videoBlobMap = {};
        window.__videoBlobMap[objectUrl] = blob;
        // Keep track of last blob to revoke later when replaced
        if (lastBlobUrlRef.current && lastBlobUrlRef.current.startsWith('blob:')) {
          try { URL.revokeObjectURL(lastBlobUrlRef.current); } catch {}
          try { if (window.__videoBlobMap) delete window.__videoBlobMap[lastBlobUrlRef.current]; } catch {}
        }
        lastBlobUrlRef.current = objectUrl;
        // Notify consumers to switch to blob (acts like uploaded)
        if (onVideoUrlReady) onVideoUrlReady(objectUrl);
        window.dispatchEvent(new CustomEvent('currentFileUrlChanged', { detail: { url: objectUrl } }));
      } catch (e) {
        // Non-fatal: keep using direct URL; waveform may still work if server sends proper CORS
        console.log('[VideoPreview] Failed to convert to blob, using direct URL:', e.message);
      }
    })();

    return () => {
      // Keep blob alive for the session; it will be replaced on next change
    };
  }, [videoUrl, optimizedVideoUrl, useOptimizedPreview, onVideoUrlReady]);

  // Handle video source switching while preserving playback state
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Store current state before source change
    const wasPlaying = !videoElement.paused;
    const currentVideoTime = videoElement.currentTime;

    // Determine the new source
    const newSrc = useOptimizedPreview && optimizedVideoUrl ? optimizedVideoUrl : videoUrl;

    // Only update if the source actually changed
    if (newSrc && videoElement.src !== newSrc) {
      console.log('[VideoPreview] Switching video source, preserving state:', {
        wasPlaying,
        currentVideoTime,
        useOptimizedPreview,
        optimizedVideoUrl: !!optimizedVideoUrl,
        videoUrl: !!videoUrl,
        newSrc: newSrc.substring(0, 50) + '...'
      });

      // Pause the video first to prevent UI state issues
      if (wasPlaying) {
        videoElement.pause();
      }

      // Immediately update UI to reflect paused state during transition
      setIsPlaying(false);

      // Set new source
      videoElement.src = newSrc;

      // Handle the load event to restore state
      const handleLoadedData = () => {
        // Restore time position (with safety checks)
        if (currentVideoTime > 0 && videoElement.duration && currentVideoTime < videoElement.duration) {
          videoElement.currentTime = currentVideoTime;
        }

        // Restore play state
        if (wasPlaying) {
          videoElement.play().then(() => {
            console.log('[VideoPreview] Successfully resumed playback after source switch');
            setIsPlaying(true);

            // Double-check UI state after a short delay to ensure synchronization
            setTimeout(() => {
              const actuallyPlaying = !videoElement.paused;
              if (actuallyPlaying !== isPlaying) {
                console.log('[VideoPreview] Correcting UI state mismatch:', { actuallyPlaying, uiState: isPlaying });
                setIsPlaying(actuallyPlaying);
              }
            }, 100);
          }).catch(error => {
            console.warn('[VideoPreview] Could not auto-resume playback:', error);
            // Ensure UI reflects the actual state
            setIsPlaying(false);
          });
        } else {
          // Ensure UI reflects paused state and controls are clickable
          setIsPlaying(false);
        }

        // Clean up event listener
        videoElement.removeEventListener('loadeddata', handleLoadedData);
      };

      // Handle loading errors
      const handleLoadError = () => {
        console.error('[VideoPreview] Error loading new video source');
        setIsPlaying(false);
        videoElement.removeEventListener('loadeddata', handleLoadedData);
        videoElement.removeEventListener('error', handleLoadError);
      };

      // Add event listeners
      videoElement.addEventListener('loadeddata', handleLoadedData);
      videoElement.addEventListener('error', handleLoadError);

      // Load the new source
      videoElement.load();

      // Additional safety: sync UI state after source change is complete
      const syncTimeout = setTimeout(() => {
        const actuallyPlaying = !videoElement.paused;
        if (actuallyPlaying !== isPlaying) {
          console.log('[VideoPreview] Final UI state sync after source switch:', { actuallyPlaying, uiState: isPlaying });
          setIsPlaying(actuallyPlaying);
        }
      }, 500); // Give enough time for the video to load and play if needed

      // Clean up timeout if component unmounts
      return () => {
        clearTimeout(syncTimeout);
        videoElement.removeEventListener('loadeddata', handleLoadedData);
        videoElement.removeEventListener('error', handleLoadError);
      };
    }
  }, [useOptimizedPreview, optimizedVideoUrl, videoUrl, isPlaying]);

  // Debug logging removed for production

  // Check download status at interval if we have a videoId
  useEffect(() => {
    if (!videoId) return;

    // Clear any existing interval
    if (downloadCheckInterval) {
      clearInterval(downloadCheckInterval);
    }

    // Set up a new interval to check download status
    const interval = setInterval(() => {
      const status = checkDownloadStatus(videoId);

      if (status.status === 'completed') {
        setVideoUrl(status.url);
        setIsDownloading(false);
        clearInterval(interval);
        setDownloadCheckInterval(null); // Reset the interval state
      } else if (status.status === 'error') {
        setError(t('preview.videoError', `Error loading video: ${status.error}`));
        setIsDownloading(false);
        clearInterval(interval);
        setDownloadCheckInterval(null); // Reset the interval state
      } else if (status.status === 'not_found') {
        // If the download was cancelled or doesn't exist, stop checking
        setIsDownloading(false);
        clearInterval(interval);
        setDownloadCheckInterval(null); // Reset the interval state
      } else if (status.status === 'downloading') {
        // Only update progress if we're actually downloading and progress is > 0
        if (status.progress > 0) {
          setIsDownloading(true);
          setDownloadProgress(status.progress);
        } else {
          // If progress is 0, don't show the downloading UI
          setIsDownloading(false);
        }
      }
    }, 1000);

    setDownloadCheckInterval(interval);

    // Clean up on unmount
    return () => {
      clearInterval(interval);
      // Don't update state during cleanup to avoid React warnings
    };
  }, [videoId, t]);

  // processVideoUrl is now defined inside the useEffect above

  // We don't need a separate cleanup effect since we're handling cleanup in the main effect above

  // Handle native video element
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Validate the video URL
    if (!videoUrl) {

      setError(t('preview.videoError', 'No video URL provided.'));
      return;
    }

    // Event handlers
    const handleMetadataLoaded = () => {
      // Only log in development mode
      if (process.env.NODE_ENV === 'development') {

      }
      setIsLoaded(true);
      setDuration(videoElement.duration);
      setError(''); // Clear any previous errors
    };

    const handleError = (e) => {
      // Get more detailed information about the error
      let errorDetails = '';
      if (videoElement.error) {
        const errorCode = videoElement.error.code;
        switch (errorCode) {
          case MediaError.MEDIA_ERR_ABORTED:
            errorDetails = 'Video playback was aborted.';
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            errorDetails = 'Network error. Check your internet connection.';
            break;
          case MediaError.MEDIA_ERR_DECODE:
            errorDetails = 'Video decoding error. The file might be corrupted.';
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorDetails = 'Video format or MIME type is not supported by your browser.';
            break;
          default:
            errorDetails = `Unknown error (code: ${errorCode}).`;
        }
      }

      console.error('Video element error:', e, errorDetails);
      setError(t('preview.videoError', `Error loading video: ${errorDetails}`));
      setIsLoaded(false);
    };

    const handleTimeUpdate = () => {
      // Only update currentTime if we're not in a seek operation or dragging
      if (!seekLockRef.current && !isDragging) {
        // Throttle time updates to reduce unnecessary re-renders
        // Only update if more than 100ms has passed since the last update
        const now = performance.now();
        if (now - lastTimeUpdateRef.current > 100) {
          const currentVideoTime = videoElement.currentTime;
          setCurrentTime(currentVideoTime);
          lastTimeUpdateRef.current = now;

          // Determine which subtitle array to use based on settings
          const useTranslated = subtitleSettings.showTranslatedSubtitles && translatedSubtitles && translatedSubtitles.length > 0;
          const subtitlesToUse = useTranslated ? translatedSubtitles : subtitlesArray;

          // Find the current subtitle based on the video's current time
          if (subtitlesToUse && subtitlesToUse.length > 0) {
            const currentSub = subtitlesToUse.find(sub => {
              // Handle both numeric and string time formats
              const startTime = typeof sub.start === 'number' ? sub.start :
                               (typeof sub.startTime === 'string' ? convertTimeStringToSeconds(sub.startTime) :
                               convertTimeStringToSeconds(sub.start));
              const endTime = typeof sub.end === 'number' ? sub.end :
                             (typeof sub.endTime === 'string' ? convertTimeStringToSeconds(sub.endTime) :
                             convertTimeStringToSeconds(sub.end));
              return currentVideoTime >= startTime && currentVideoTime <= endTime;
            });

            // Update the current subtitle text
            if (currentSub) {
              setCurrentSubtitleText(currentSub.text);
              // Only log in development mode and throttle to avoid excessive logging
              if (process.env.NODE_ENV === 'development') {
                // Store the last logged subtitle to avoid logging the same one repeatedly
                if (!window._lastLoggedSubtitle || window._lastLoggedSubtitle !== currentSub.text) {

                  window._lastLoggedSubtitle = currentSub.text;
                }
              }

              // Update fullscreen subtitle if in fullscreen mode
              const container = document.getElementById('fullscreen-subtitle-overlay');

              if (container) {
                // Clear existing content
                container.innerHTML = '';

                // Create subtitle element
                const subtitle = document.createElement('div');
                subtitle.id = 'fullscreen-subtitle';
                console.log('ðŸŽ¬ SUBTITLE - Created subtitle element');

                // Handle newlines by splitting the text and adding <br> tags
                const lines = currentSub.text.split('\n');
                lines.forEach((line, index) => {
                  if (index > 0) {
                    subtitle.appendChild(document.createElement('br'));
                  }
                  subtitle.appendChild(document.createTextNode(line));
                });

                // Apply styles
                subtitle.style.display = 'inline-block';
                subtitle.style.backgroundColor = `rgba(${parseInt(subtitleSettings.backgroundColor.slice(1, 3), 16)},
                                               ${parseInt(subtitleSettings.backgroundColor.slice(3, 5), 16)},
                                               ${parseInt(subtitleSettings.backgroundColor.slice(5, 7), 16)},
                                               ${subtitleSettings.opacity || '0.7'})`;
                subtitle.style.color = subtitleSettings.textColor || '#ffffff';
                subtitle.style.padding = `${subtitleSettings.backgroundPadding || '10'}px`;
                subtitle.style.borderRadius = `${subtitleSettings.backgroundRadius || '4'}px`;
                subtitle.style.fontFamily = subtitleSettings.fontFamily || 'Arial, sans-serif';
                subtitle.style.fontVariationSettings = subtitleSettings.fontVariationSettings || 'normal';
                subtitle.style.fontSize = `${subtitleSettings.fontSize || '24'}px`;
                subtitle.style.fontWeight = subtitleSettings.fontWeight || '400';
                subtitle.style.lineHeight = subtitleSettings.lineSpacing || '1.4';
                subtitle.style.letterSpacing = `${subtitleSettings.letterSpacing || '0'}px`;
                subtitle.style.textTransform = subtitleSettings.textTransform || 'none';
                subtitle.style.textShadow = subtitleSettings.textShadow === true || subtitleSettings.textShadow === 'true' ?
                                          '1px 1px 2px rgba(0, 0, 0, 0.8)' : 'none';
                subtitle.style.maxWidth = '100%';
                subtitle.style.overflowWrap = 'break-word';

                // Add to container
                container.appendChild(subtitle);
                console.log('ðŸŽ¬ SUBTITLE - Subtitle added to container');
              }
            } else {
              setCurrentSubtitleText('');

              // Clear fullscreen subtitle if in fullscreen mode
              const container = document.getElementById('fullscreen-subtitle-overlay');
              if (container) {
                container.innerHTML = '';
              }
            }
          }
        }
      }

      // Update play state in ref to avoid unnecessary re-renders
      const currentlyPlaying = !videoElement.paused;
      if (currentlyPlaying !== lastPlayStateRef.current) {
        lastPlayStateRef.current = currentlyPlaying;
      }
    };

    const handlePlayPauseEvent = () => {
      // Update play state in ref to avoid unnecessary re-renders
      const currentlyPlaying = !videoElement.paused;
      if (currentlyPlaying !== lastPlayStateRef.current) {
        lastPlayStateRef.current = currentlyPlaying;
      }
    };

    const handleSeeking = () => {
      seekLockRef.current = true;
    };

    const handleSeeked = () => {
      // Update the current time immediately when seeking is complete
      setCurrentTime(videoElement.currentTime);
      lastTimeUpdateRef.current = performance.now();

      // Notify parent component about the seek operation
      if (onSeek) {
        onSeek(videoElement.currentTime);
      }

      // Release the seek lock immediately
      seekLockRef.current = false;
    };

    // Add event listeners
    videoElement.addEventListener('loadedmetadata', handleMetadataLoaded);
    videoElement.addEventListener('error', handleError);
    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('play', handlePlayPauseEvent);
    videoElement.addEventListener('pause', handlePlayPauseEvent);
    videoElement.addEventListener('seeking', handleSeeking);
    videoElement.addEventListener('seeked', handleSeeked);

    // Clean up
    return () => {
      videoElement.removeEventListener('loadedmetadata', handleMetadataLoaded);
      videoElement.removeEventListener('error', handleError);
      videoElement.removeEventListener('timeupdate', handleTimeUpdate);
      videoElement.removeEventListener('play', handlePlayPauseEvent);
      videoElement.removeEventListener('pause', handlePlayPauseEvent);
      videoElement.removeEventListener('seeking', handleSeeking);
      videoElement.removeEventListener('seeked', handleSeeked);
    };
  }, [videoUrl, setCurrentTime, setDuration, t, onSeek, subtitlesArray, translatedSubtitles, subtitleSettings, isDragging]);

  // Native track subtitles disabled - using only custom subtitle display

  // Listen for aligned narration generation events
  useEffect(() => {
    // Function to handle aligned narration status updates
    const handleAlignedNarrationStatus = (event) => {
      if (event.detail) {
        const { status, message, isStillGenerating } = event.detail;

        // If the status is 'complete' and isStillGenerating is false, the narration regeneration is fully done
        if (status === 'complete' && !isStillGenerating) {

          setIsRefreshingNarration(false);
        }

        // If the status is 'error' and isStillGenerating is false, there was an error during regeneration
        if (status === 'error' && !isStillGenerating) {
          console.error('Error during aligned narration regeneration:', message);
          setIsRefreshingNarration(false);
        }

        // If isStillGenerating is true, keep the overlay visible
        if (isStillGenerating) {

        }
      }
    };

    // Function to handle aligned narration generation state changes
    const handleAlignedNarrationGeneratingState = (event) => {
      if (event.detail) {
        const { isGenerating } = event.detail;

        // If isGenerating is false, the narration generation is complete
        if (!isGenerating && !isRefreshingNarration) {
          return; // No need to update if we're not refreshing
        }

        if (!isGenerating) {

          setIsRefreshingNarration(false);
        }
      }
    };

    // Add event listeners
    window.addEventListener('aligned-narration-status', handleAlignedNarrationStatus);
    window.addEventListener('aligned-narration-generating-state', handleAlignedNarrationGeneratingState);

    // Clean up event listeners
    return () => {
      window.removeEventListener('aligned-narration-status', handleAlignedNarrationStatus);
      window.removeEventListener('aligned-narration-generating-state', handleAlignedNarrationGeneratingState);
    };
  }, [isRefreshingNarration]);

  // The duplicate event listener for aligned-narration-status has been removed
  // We're now only using the more comprehensive listener above that includes isStillGenerating

  // Clean up aligned narration resources when component unmounts
  useEffect(() => {
    return () => {
      // Clean up aligned narration audio
      if (typeof window.resetAlignedNarration === 'function') {
        console.log('Cleaning up aligned narration on component unmount');
        window.resetAlignedNarration();
      }

      // Also clean up any other audio elements that might be playing
      if (window.alignedAudioElement) {
        try {
          console.log('Cleaning up alignedAudioElement on component unmount');
          window.alignedAudioElement.pause();
          window.alignedAudioElement.src = '';
          window.alignedAudioElement.load();
          window.alignedAudioElement = null;
        } catch (e) {
          console.warn('Error cleaning up window.alignedAudioElement on unmount:', e);
        }
      }
    };
  }, []);

  // Function to handle fullscreen exit (used by both button and ESC key)
  const handleFullscreenExit = useCallback(() => {
    console.log('ðŸŽ¬ MANUAL EXIT: Starting fullscreen exit process');

    // Try all exit fullscreen methods
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(console.error);
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }

    // Force state update if needed
    setTimeout(() => {
      const stillFullscreen = !!(document.fullscreenElement ||
                               document.webkitFullscreenElement ||
                               document.mozFullScreenElement ||
                               document.msFullscreenElement);
      if (!stillFullscreen) {
        console.log('ðŸŽ¬ MANUAL EXIT: Exiting fullscreen, resetting styles');

        // Reset all styles
        const videoElement = document.querySelector('.native-video-container video');
        const videoWrapper = document.querySelector('.native-video-container .video-wrapper');
        const container = document.querySelector('.native-video-container');

        if (videoElement) {
          videoElement.style.removeProperty('width');
          videoElement.style.removeProperty('height');
          videoElement.style.removeProperty('object-fit');
          videoElement.style.removeProperty('position');
          videoElement.style.removeProperty('top');
          videoElement.style.removeProperty('left');
          videoElement.style.removeProperty('z-index');
          videoElement.style.removeProperty('max-width');
          videoElement.style.removeProperty('max-height');
          videoElement.style.removeProperty('min-width');
          videoElement.style.removeProperty('min-height');
          videoElement.style.removeProperty('transform');
          videoElement.style.removeProperty('border-radius');
          videoElement.classList.remove('fullscreen-video');
        }

        if (videoWrapper) {
          videoWrapper.style.removeProperty('width');
          videoWrapper.style.removeProperty('height');
          videoWrapper.style.removeProperty('position');
          videoWrapper.style.removeProperty('top');
          videoWrapper.style.removeProperty('left');
          videoWrapper.style.removeProperty('z-index');
          videoWrapper.style.removeProperty('overflow');
        }

        if (container) {
          container.style.removeProperty('width');
          container.style.removeProperty('height');
          container.style.removeProperty('position');
          container.style.removeProperty('top');
          container.style.removeProperty('left');
          container.style.removeProperty('z-index');
          container.style.removeProperty('background');
          // Reset cursor to default
          container.style.cursor = 'default';
        }

        setIsFullscreen(false);
        setControlsVisible(false); // Reset controls to hidden when exiting fullscreen (normal mode uses hover)
        // FIX: Check if mouse is still hovering and set state accordingly
        if (videoContainerRef.current?.matches(':hover')) {
          setIsVideoHovered(true);
        } else {
          setIsVideoHovered(false);
        }
        console.log('ðŸŽ¬ MANUAL EXIT: Exit fullscreen styles reset');
      }
    }, 100);
  }, []);

  // Handle fullscreen changes
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Function to create and inject fullscreen subtitle container
    const createFullscreenSubtitleContainer = () => {
      console.log('ðŸŽ¬ SUBTITLE - Creating fullscreen subtitle container');

      // Check if container already exists
      let container = document.getElementById('fullscreen-subtitle-overlay');
      if (!container) {
        console.log('ðŸŽ¬ SUBTITLE - Container does not exist, creating new one');
        container = document.createElement('div');
        container.id = 'fullscreen-subtitle-overlay';
        container.style.position = 'fixed';
        container.style.left = '0';
        container.style.right = '0';
        container.style.bottom = '10%';
        container.style.width = `${subtitleSettings.boxWidth || '80'}%`;
        container.style.margin = '0 auto';
        container.style.textAlign = 'center';
        container.style.zIndex = '999999'; // Higher than video z-index
        container.style.pointerEvents = 'none';
        container.style.backgroundColor = 'rgba(255, 0, 0, 0.3)'; // Debug: red background
        document.body.appendChild(container);
        console.log('ðŸŽ¬ SUBTITLE - Container created and added to body');
      } else {
        console.log('ðŸŽ¬ SUBTITLE - Container already exists, reusing');
        // Force update styles in case they were lost
        container.style.zIndex = '999999';
        container.style.position = 'fixed';
        container.style.backgroundColor = 'rgba(255, 0, 0, 0.3)'; // Debug: red background
      }

      // Debug: Check container position and visibility
      const rect = container.getBoundingClientRect();
      console.log('ðŸŽ¬ SUBTITLE - Container position:', {
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
        zIndex: container.style.zIndex,
        isVisible: rect.width > 0 && rect.height > 0
      });

      return container;
    };

    // Function to handle fullscreen change events
    const handleFullscreenChange = () => {
      console.log('ðŸŽ¬ FULLSCREEN CHANGE EVENT TRIGGERED');
      const isDocFullscreen = !!document.fullscreenElement ||
                             !!document.webkitFullscreenElement ||
                             !!document.mozFullScreenElement ||
                             !!document.msFullscreenElement;
      console.log('ðŸŽ¬ Document fullscreen state:', isDocFullscreen);

      // Check if our video container is the fullscreen element
      const container = videoContainerRef.current;
      const isVideoFullscreen = isDocFullscreen &&
                              (document.fullscreenElement === container ||
                               document.webkitFullscreenElement === container ||
                               document.mozFullScreenElement === container ||
                               document.msFullscreenElement === container);

      console.log('ðŸŽ¬ Video fullscreen check:', {
        container: !!container,
        isDocFullscreen,
        isVideoFullscreen,
        fullscreenElement: document.fullscreenElement
      });

      setIsFullscreen(isVideoFullscreen);
      console.log('ðŸŽ¬ Setting isFullscreen state to:', isVideoFullscreen);

      // Reset control states when exiting fullscreen
      if (!isVideoFullscreen) {
        setControlsVisible(false); // Reset controls to hidden when exiting fullscreen (normal mode uses hover)
        // FIX: Check hover state when exiting
        if (videoContainerRef.current?.matches(':hover')) {
          setIsVideoHovered(true);
        } else {
          setIsVideoHovered(false);
        }
        console.log('ðŸŽ¬ FULLSCREEN EXIT: Reset control states');
      }

      // Only log in development mode
      if (process.env.NODE_ENV === 'development') {
        console.log('Fullscreen change:', {
          isDocFullscreen,
          isVideoFullscreen,
          fullscreenElement: document.fullscreenElement,
          container
        });
      }

      // If entering fullscreen, create the subtitle container and setup controls
      if (isVideoFullscreen) {
        console.log('ðŸŽ¬ ENTERING FULLSCREEN - Starting video resize process');
        createFullscreenSubtitleContainer();
        // Add a class to the video element to help with styling
        videoElement.classList.add('fullscreen-video');

        console.log('ðŸŽ¬ ENTERING FULLSCREEN - Setting controls visible immediately');
        setControlsVisible(true);
        setShowCustomControls(true); // Force custom controls to be rendered

        // Force controls to be visible by directly setting CSS
        setTimeout(() => {
          console.log('ðŸŽ¬ FORCE VISIBLE - Directly setting control styles');
          const container = videoContainerRef.current;
          if (container) {
            const controlElements = container.querySelectorAll('[style*="opacity"]');
            controlElements.forEach((element) => {
              // className can be an object on SVG elements (SVGAnimatedString), so don't assume it's a string
              const classAttr = typeof element.className === 'string'
                ? element.className
                : (element.getAttribute && element.getAttribute('class')) || '';
              const hasLiquidGlass = element.classList && element.classList.contains('liquid-glass');
              const hasInteractive = element.classList && element.classList.contains('interactive');

              if ((hasLiquidGlass && hasInteractive) || (classAttr.includes('liquid-glass') && classAttr.includes('interactive'))) {
                const rect = element.getBoundingClientRect();
                const computedStyle = getComputedStyle(element);

                console.log('ðŸŽ¬ INVESTIGATION - Element details:', {
                  className: classAttr,
                  opacity: computedStyle.opacity,
                  display: computedStyle.display,
                  visibility: computedStyle.visibility,
                  zIndex: computedStyle.zIndex,
                  position: computedStyle.position,
                  transform: computedStyle.transform,
                  width: rect.width,
                  height: rect.height,
                  x: rect.x,
                  y: rect.y,
                  isOnScreen: rect.x >= 0 && rect.y >= 0 && rect.x < window.innerWidth && rect.y < window.innerHeight
                });

                element.style.setProperty('opacity', '1', 'important');
                element.style.setProperty('pointer-events', 'auto', 'important');
                element.style.setProperty('z-index', '999999', 'important');
                element.style.setProperty('display', 'flex', 'important');
                element.style.setProperty('visibility', 'visible', 'important');
                element.style.setProperty('transform', 'none', 'important');
              }
            });
          }
        }, 100);

        // Force video and container to fill fullscreen with JavaScript
        setTimeout(() => {
          if (videoElement) {
            console.log('ðŸŽ¬ APPLYING FULLSCREEN STYLES TO VIDEO');
            console.log('Video element before:', {
              width: videoElement.style.width,
              height: videoElement.style.height,
              objectFit: videoElement.style.objectFit,
              position: videoElement.style.position
            });

            // Use setProperty with important flag to override any existing styles
            videoElement.style.setProperty('width', '100vw', 'important');
            videoElement.style.setProperty('height', '100vh', 'important');
            videoElement.style.setProperty('object-fit', 'contain', 'important');
            videoElement.style.setProperty('position', 'fixed', 'important');
            videoElement.style.setProperty('top', '0', 'important');
            videoElement.style.setProperty('left', '0', 'important');
            videoElement.style.setProperty('z-index', '1', 'important');
            videoElement.style.setProperty('max-width', 'none', 'important');
            videoElement.style.setProperty('max-height', 'none', 'important');
            videoElement.style.setProperty('min-width', '100vw', 'important');
            videoElement.style.setProperty('min-height', '100vh', 'important');
            videoElement.style.setProperty('transform', 'none', 'important');
            videoElement.style.setProperty('border-radius', '0', 'important');

            // Also remove any conflicting attributes
            videoElement.removeAttribute('width');
            videoElement.removeAttribute('height');

            console.log('Video element after:', {
              width: videoElement.style.width,
              height: videoElement.style.height,
              objectFit: videoElement.style.objectFit,
              position: videoElement.style.position,
              computedWidth: window.getComputedStyle(videoElement).width,
              computedHeight: window.getComputedStyle(videoElement).height,
              computedObjectFit: window.getComputedStyle(videoElement).objectFit
            });

            // Force video wrapper styles
            const videoWrapper = videoElement.closest('.video-wrapper');
            if (videoWrapper) {
              videoWrapper.style.setProperty('width', '100vw', 'important');
              videoWrapper.style.setProperty('height', '100vh', 'important');
              videoWrapper.style.setProperty('position', 'fixed', 'important');
              videoWrapper.style.setProperty('top', '0', 'important');
              videoWrapper.style.setProperty('left', '0', 'important');
              videoWrapper.style.setProperty('z-index', '1', 'important'); // Lower than subtitle container
              videoWrapper.style.setProperty('overflow', 'hidden', 'important');
            }

            // Force container styles
            if (container) {
              container.style.setProperty('width', '100vw', 'important');
              container.style.setProperty('height', '100vh', 'important');
              container.style.setProperty('position', 'fixed', 'important');
              container.style.setProperty('top', '0', 'important');
              container.style.setProperty('left', '0', 'important');
              container.style.setProperty('z-index', '998', 'important');
              container.style.setProperty('display', 'block', 'important');
              container.style.setProperty('padding', '0', 'important');
              container.style.setProperty('margin', '0', 'important');
            }

            console.log('ðŸŽ¬ ENTERING FULLSCREEN - Auto-hide timer will be set up by useEffect');
          }
        }, 100);
      } else {
        // If exiting fullscreen, force our manual exit function to ensure proper cleanup
        console.log('ðŸŽ¬ FULLSCREEN CHANGE: Detected exit, calling manual exit function');

        // Remove the subtitle container
        const subtitleContainer = document.getElementById('fullscreen-subtitle-overlay');
        if (subtitleContainer) {
          document.body.removeChild(subtitleContainer);
        }
        videoElement.classList.remove('fullscreen-video');

        // Call our manual exit function to ensure all styles are properly reset
        // Use setTimeout to avoid potential conflicts with the browser's own cleanup
        setTimeout(() => {
          console.log('ðŸŽ¬ FULLSCREEN CHANGE: Executing manual style reset');

          // Reset all styles using the same logic as the button
          const videoElement = document.querySelector('.native-video-container video');
          const videoWrapper = document.querySelector('.native-video-container .video-wrapper');
          const container = videoContainerRef.current;

          if (videoElement) {
            videoElement.style.removeProperty('width');
            videoElement.style.removeProperty('height');
            videoElement.style.removeProperty('object-fit');
            videoElement.style.removeProperty('position');
            videoElement.style.removeProperty('top');
            videoElement.style.removeProperty('left');
            videoElement.style.removeProperty('z-index');
            videoElement.style.removeProperty('max-width');
            videoElement.style.removeProperty('max-height');
            videoElement.style.removeProperty('min-width');
            videoElement.style.removeProperty('min-height');
            videoElement.style.removeProperty('transform');
            videoElement.style.removeProperty('border-radius');
            videoElement.classList.remove('fullscreen-video');
          }

          if (videoWrapper) {
            videoWrapper.style.removeProperty('width');
            videoWrapper.style.removeProperty('height');
            videoWrapper.style.removeProperty('position');
            videoWrapper.style.removeProperty('top');
            videoWrapper.style.removeProperty('left');
            videoWrapper.style.removeProperty('z-index');
            videoWrapper.style.removeProperty('overflow');
          }

          if (container) {
            container.style.removeProperty('width');
            container.style.removeProperty('height');
            container.style.removeProperty('position');
            container.style.removeProperty('top');
            container.style.removeProperty('left');
            container.style.removeProperty('z-index');
            container.style.removeProperty('background');
            container.style.removeProperty('display');
            container.style.removeProperty('padding');
            container.style.removeProperty('margin');
            // Reset cursor to default
            container.style.cursor = 'default';
          }

          console.log('ðŸŽ¬ FULLSCREEN CHANGE: Manual style reset complete');
        }, 50);

        // Additional cleanup: If we're not in fullscreen but still have fullscreen styles, force cleanup
        if (!isDocFullscreen) {
          console.log('ðŸŽ¬ FORCE CLEANUP: Document not in fullscreen, ensuring all styles are reset');
          setTimeout(() => {
            // Force reset all possible fullscreen styles
            const allVideos = document.querySelectorAll('video');
            allVideos.forEach(video => {
              if (video.style.position === 'fixed' || video.style.width === '100vw') {
                console.log('ðŸŽ¬ FORCE CLEANUP: Removing styles from video element');
                video.style.removeProperty('width');
                video.style.removeProperty('height');
                video.style.removeProperty('object-fit');
                video.style.removeProperty('position');
                video.style.removeProperty('top');
                video.style.removeProperty('left');
                video.style.removeProperty('z-index');
                video.style.removeProperty('max-width');
                video.style.removeProperty('max-height');
                video.style.removeProperty('min-width');
                video.style.removeProperty('min-height');
                video.style.removeProperty('transform');
                video.style.removeProperty('border-radius');
                video.classList.remove('fullscreen-video');
              }
            });

            // Force reset all video wrappers
            const allWrappers = document.querySelectorAll('.video-wrapper');
            allWrappers.forEach(wrapper => {
              if (wrapper.style.position === 'fixed' || wrapper.style.width === '100vw') {
                console.log('ðŸŽ¬ FORCE CLEANUP: Removing styles from video wrapper');
                wrapper.style.removeProperty('width');
                wrapper.style.removeProperty('height');
                wrapper.style.removeProperty('position');
                wrapper.style.removeProperty('top');
                wrapper.style.removeProperty('left');
                wrapper.style.removeProperty('z-index');
                wrapper.style.removeProperty('overflow');
              }
            });

            // Force reset all video containers
            const allContainers = document.querySelectorAll('.native-video-container');
            allContainers.forEach(container => {
              if (container.style.position === 'fixed' || container.style.width === '100vw') {
                console.log('ðŸŽ¬ FORCE CLEANUP: Removing styles from video container');
                container.style.removeProperty('width');
                container.style.removeProperty('height');
                container.style.removeProperty('position');
                container.style.removeProperty('top');
                container.style.removeProperty('left');
                container.style.removeProperty('z-index');
                container.style.removeProperty('display');
                container.style.removeProperty('padding');
                container.style.removeProperty('margin');
                container.style.cursor = 'default';
              }
            });

            // Ensure React state is also updated
            setIsFullscreen(false);
            setControlsVisible(false); // Reset controls to hidden when exiting fullscreen (normal mode uses hover)
            // FIX: Check hover state when exiting
            if (videoContainerRef.current?.matches(':hover')) {
              setIsVideoHovered(true);
            } else {
              setIsVideoHovered(false);
            }
          }, 50);
        }
      }
    };

    // Add event listeners for all browser variants
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    // Add window-level listener to catch any missed fullscreen changes
    const handleWindowResize = () => {
      // Check if we think we're in fullscreen but actually aren't
      const isActuallyFullscreen = !!(document.fullscreenElement ||
                                     document.webkitFullscreenElement ||
                                     document.mozFullScreenElement ||
                                     document.msFullscreenElement);

      if (isFullscreen && !isActuallyFullscreen) {
        console.log('ðŸŽ¬ WINDOW RESIZE: Detected fullscreen state mismatch, forcing cleanup');
        handleFullscreenChange();
      }
    };

    window.addEventListener('resize', handleWindowResize);

    // Add ESC key listener - let browser handle exit, but ensure our cleanup runs
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && isFullscreen) {
        console.log('ðŸŽ¬ ESC KEY: Detected ESC press while in fullscreen, will let browser exit and cleanup will follow');
        // Don't prevent default - let browser handle the exit
        // Our handleFullscreenChange will be called and will do the proper cleanup
      }
    };

    document.addEventListener('keydown', handleEscKey);

    // Clean up
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
      window.removeEventListener('resize', handleWindowResize);
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [subtitleSettings.boxWidth, handleFullscreenExit, isFullscreen]);

  // Simplified: Controls are always visible in fullscreen via CSS logic above

  // Custom video controls event handlers
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleLoadedMetadata = () => {
      setVideoDuration(videoElement.duration);
      setDuration(videoElement.duration);
      setVolume(videoElement.volume);
      setIsMuted(videoElement.muted);
      setShowCustomControls(true);
    };

    const handleTimeUpdate = () => {
      // Only update currentTime if we're not dragging
      if (!isDragging) {
        setCurrentTime(videoElement.currentTime); // Use existing currentTime prop
      }

      // Update buffered progress
      if (videoElement.buffered.length > 0 && videoDuration > 0) {
        const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1);
        setBufferedProgress((bufferedEnd / videoDuration) * 100);
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
    };

    const handlePause = () => {
      setIsPlaying(false);
    };

    const handleVolumeChange = () => {
      setVolume(videoElement.volume);
      setIsMuted(videoElement.muted);
    };

    const handleLoadStart = () => {
      setIsVideoLoading(true);
    };

    const handleCanPlay = () => {
      setIsVideoLoading(false);
    };

    const handleWaiting = () => {
      setIsBuffering(true);
    };

    const handleCanPlayThrough = () => {
      setIsBuffering(false);
    };

    // Add video event listeners
    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('volumechange', handleVolumeChange);
    videoElement.addEventListener('loadstart', handleLoadStart);
    videoElement.addEventListener('canplay', handleCanPlay);
    videoElement.addEventListener('waiting', handleWaiting);
    videoElement.addEventListener('canplaythrough', handleCanPlayThrough);

    return () => {
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('timeupdate', handleTimeUpdate);
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('volumechange', handleVolumeChange);
      videoElement.removeEventListener('loadstart', handleLoadStart);
      videoElement.removeEventListener('canplay', handleCanPlay);
      videoElement.removeEventListener('waiting', handleWaiting);
      videoElement.removeEventListener('canplaythrough', handleCanPlayThrough);
    };
  }, [videoUrl, isDragging, setDuration, setCurrentTime, videoDuration]);



  const handleTimelineMouseDown = useCallback((e) => {
    if (!videoRef.current || videoDuration === 0) return;

    // Store the timeline container reference for consistent dragging
    const timelineContainer = e.currentTarget;
    const rect = timelineContainer.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const newTime = Math.max(0, Math.min((clickX / rect.width) * videoDuration, videoDuration));

    // Set seek lock to prevent timeupdate interference
    seekLockRef.current = true;

    // Set initial drag state
    setIsDragging(true);
    setDragTime(newTime);
    dragTimeRef.current = newTime;

    // Add global mouse event listeners
    const handleMouseMove = (e) => {
      // Use the stored timeline container reference instead of searching for it
      const rect = timelineContainer.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const newTime = Math.max(0, Math.min((clickX / rect.width) * videoDuration, videoDuration));
      setDragTime(newTime);
      dragTimeRef.current = newTime;
    };

    const handleMouseUp = () => {
      // Always apply the final time, whether moved or just clicked
      if (videoRef.current) {
        videoRef.current.currentTime = dragTimeRef.current;
        setCurrentTime(dragTimeRef.current);
      }

      // Reset drag state
      setIsDragging(false);

      // Release seek lock after a short delay to allow video to settle
      setTimeout(() => {
        seekLockRef.current = false;
      }, 100);

      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [videoDuration, setCurrentTime]);

  // Touch support for timeline
  const handleTimelineTouchStart = useCallback((e) => {
    if (!videoRef.current || videoDuration === 0) return;

    e.preventDefault();
    // Store the timeline container reference for consistent dragging
    const timelineContainer = e.currentTarget;
    const rect = timelineContainer.getBoundingClientRect();
    const touch = e.touches[0];
    const touchX = touch.clientX - rect.left;
    const newTime = Math.max(0, Math.min((touchX / rect.width) * videoDuration, videoDuration));

    // Set seek lock to prevent timeupdate interference
    seekLockRef.current = true;

    // Set initial drag state
    setIsDragging(true);
    setDragTime(newTime);
    dragTimeRef.current = newTime;

    // Add global touch event listeners
    const handleTouchMove = (e) => {
      e.preventDefault();
      // Use the stored timeline container reference instead of searching for it
      if (e.touches[0]) {
        const rect = timelineContainer.getBoundingClientRect();
        const touchX = e.touches[0].clientX - rect.left;
        const newTime = Math.max(0, Math.min((touchX / rect.width) * videoDuration, videoDuration));
        setDragTime(newTime);
        dragTimeRef.current = newTime;
      }
    };

    const handleTouchEnd = () => {
      // Always apply the final time
      if (videoRef.current) {
        videoRef.current.currentTime = dragTimeRef.current;
        setCurrentTime(dragTimeRef.current);
      }

      // Reset drag state
      setIsDragging(false);

      // Release seek lock after a short delay to allow video to settle
      setTimeout(() => {
        seekLockRef.current = false;
      }, 100);

      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
  }, [videoDuration, setCurrentTime]);

  // Handle volume slider dragging
  useEffect(() => {
    if (!isVolumeDragging) return;

    const volumeSlider = document.querySelector('.expanding-volume-slider');

    const updateFromClientY = (clientY) => {
      if (!volumeSlider) return;
      const rect = volumeSlider.getBoundingClientRect();
      const newVolume = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
      setVolume(newVolume);
      if (videoRef.current) {
        videoRef.current.volume = newVolume;
        videoRef.current.muted = newVolume === 0;
        setIsMuted(newVolume === 0);
      }
    };

    const handleMouseMove = (e) => {
      updateFromClientY(e.clientY);
    };

    const handleMouseUp = () => {
      setIsVolumeDragging(false);
    };

    const handleTouchMove = (e) => {
      // Prevent scrolling while dragging the volume slider
      e.preventDefault();
      const touch = e.touches && e.touches[0];
      if (touch) {
        updateFromClientY(touch.clientY);
      }
    };

    const handleTouchEnd = () => {
      setIsVolumeDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isVolumeDragging]);

  // Mobile: keep volume slider expanded after touch until user taps outside
  useEffect(() => {
    const handleOutside = (e) => {
      if (!isVolumeSliderVisible) return;
      const wrapper = document.querySelector('.volume-pill-wrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        setIsVolumeSliderVisible(false);
      }
    };

    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [isVolumeSliderVisible, setIsVolumeSliderVisible]);


  // Handle keyboard shortcuts for video control
  useEffect(() => {
    const handleKeyDown = (event) => {
      // Handle multiple keyboard shortcuts
      const validKeys = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyM', 'KeyF', 'KeyK'];
      // Safely check event.key - it might be undefined during browser autocomplete
      const eventKey = event.key ? event.key.toLowerCase() : '';
      if (!validKeys.includes(event.code) && !['j', 'l', 'k', 'm', 'f', ' '].includes(eventKey)) return;

      // Don't handle spacebar if user is typing in an input field
      const activeElement = document.activeElement;
      if (activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.contentEditable === 'true' ||
        activeElement.isContentEditable
      )) {
        return;
      }

      // Don't handle spacebar if a modal is open (check for common modal classes)
      const hasOpenModal = document.querySelector(
        '.modal-overlay, .settings-modal-overlay, .advanced-settings-modal-overlay, ' +
        '.download-modal-overlay, .segment-retry-modal-overlay, .prompt-editor-overlay, ' +
        '.subtitles-input-modal-overlay, .custom-modal-overlay'
      );
      if (hasOpenModal) {
        return;
      }

      // Don't handle spacebar if the video rendering section is expanded and focused
      // This prevents conflicts with the RemotionVideoPreview
      const videoRenderingSection = document.querySelector('.video-rendering-section.expanded');
      const videoPreviewPanel = document.querySelector('.video-preview-panel');
      if (videoRenderingSection && videoPreviewPanel) {
        // Check if the user is interacting with the video rendering section
        const isInVideoRenderingArea = event.target.closest('.video-rendering-section') ||
                                      event.target.closest('.video-preview-panel');
        if (isInVideoRenderingArea) {
          return; // Let the RemotionVideoPreview handle its own spacebar events
        }
      }

      // Only proceed if video element exists and is loaded
      const videoElement = videoRef.current;
      if (!videoElement || !isLoaded) return;

      // Prevent default behavior for handled keys
      event.preventDefault();
      event.stopPropagation();

      // Handle different keyboard shortcuts
      // Safely check event.key - it might be undefined during browser autocomplete
      switch (event.code || eventKey) {
        case 'Space':
        case ' ':
        case 'KeyK':
        case 'k':
          // Toggle play/pause
          if (videoElement.paused) {
            videoElement.play().catch(error => {
              console.error('Error playing video:', error);
            });
          } else {
            videoElement.pause();
          }
          break;

        case 'ArrowUp':
          // Volume up
          videoElement.volume = Math.min(1, videoElement.volume + 0.1);
          setVolume(videoElement.volume);
          if (videoElement.muted) {
            videoElement.muted = false;
            setIsMuted(false);
          }
          break;

        case 'ArrowDown':
          // Volume down
          videoElement.volume = Math.max(0, videoElement.volume - 0.1);
          setVolume(videoElement.volume);
          if (videoElement.volume === 0) {
            videoElement.muted = true;
            setIsMuted(true);
          }
          break;

        case 'KeyM':
        case 'm':
          // Toggle mute
          videoElement.muted = !videoElement.muted;
          setIsMuted(videoElement.muted);
          if (!videoElement.muted && videoElement.volume === 0) {
            videoElement.volume = 0.5;
            setVolume(0.5);
          }
          break;

        case 'KeyF':
        case 'f':
          // Toggle fullscreen using actual document fullscreen state (avoid stale React state)
          {
            const isDocFullscreen = !!(document.fullscreenElement ||
                                       document.webkitFullscreenElement ||
                                       document.mozFullScreenElement ||
                                       document.msFullscreenElement);
            if (isDocFullscreen) {
              handleFullscreenExit();
            } else {
              const container = videoContainerRef.current;
              if (container) {
                if (container.requestFullscreen) {
                  container.requestFullscreen();
                } else if (container.webkitRequestFullscreen) {
                  container.webkitRequestFullscreen();
                } else if (container.mozRequestFullScreen) {
                  container.mozRequestFullScreen();
                } else if (container.msRequestFullscreen) {
                  container.msRequestFullscreen();
                }
              }
            }
          }
          break;

        default:
          break;
      }
    };

    // Add global keydown listener
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isLoaded, videoDuration, handleFullscreenExit]);

  // Simplified: No auto-hide logic - controls managed purely by CSS visibility conditions

  // Mouse movement with auto-hide in fullscreen
  useEffect(() => {
    const handleMouseMove = () => {
      // Only set controlsVisible in fullscreen mode
      if (isFullscreen) {
        setControlsVisible(true);

        // Always restore cursor when showing controls
        const videoContainer = videoContainerRef.current;
        if (videoContainer) {
          videoContainer.style.cursor = 'default';
        }

        // Clear existing timer
        if (hideControlsTimeoutRef.current) {
          clearTimeout(hideControlsTimeoutRef.current);
        }

        // Set new timer to hide controls after 1 second
        hideControlsTimeoutRef.current = setTimeout(() => {
          setControlsVisible(false);
          // Hide cursor too
          const videoContainer = videoContainerRef.current;
          if (videoContainer) {
            videoContainer.style.cursor = 'none';
          }
        }, 1000);
      }
      // In normal mode, don't touch controlsVisible - let hover handle it
    };

    const videoContainer = videoContainerRef.current;
    if (videoContainer) {
      videoContainer.addEventListener('mousemove', handleMouseMove);
      return () => {
        videoContainer.removeEventListener('mousemove', handleMouseMove);
        if (hideControlsTimeoutRef.current) {
          clearTimeout(hideControlsTimeoutRef.current);
        }
      };
    }
  }, [isFullscreen]);

  // Seek to time when currentTime changes externally (from LyricsDisplay)
  useEffect(() => {
    if (!isLoaded) return;

    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Only seek if the difference is significant to avoid loops
    // Increased threshold to 0.2 seconds to further reduce unnecessary seeks
    if (Math.abs(videoElement.currentTime - currentTime) > 0.2) {
      // Set the seek lock to prevent timeupdate from overriding our seek
      seekLockRef.current = true;

      // Store the playing state
      const wasPlaying = !videoElement.paused;
      lastPlayStateRef.current = wasPlaying;

      // Set the new time without pausing first
      // This reduces the play/pause flickering
      videoElement.currentTime = currentTime;

      // Update the last time update reference
      lastTimeUpdateRef.current = performance.now();

      // Release the seek lock after a very short delay
      setTimeout(() => {
        seekLockRef.current = false;
      }, 50);
    }
  }, [currentTime, isLoaded]);

  // Handle downloading video with subtitles
  const handleDownloadWithSubtitles = async () => {
    if (!videoUrl || !subtitlesArray || subtitlesArray.length === 0) {
      setError(t('videoPreview.noSubtitlesToRender', 'No subtitles to render'));
      return;
    }

    setIsRenderingVideo(true);
    setRenderProgress(0);
    setError('');

    try {
      const renderedVideoUrl = await renderSubtitlesToVideo(
        videoUrl,
        subtitlesArray,
        subtitleSettings,
        (progress) => setRenderProgress(progress)
      );

      // Get video title or use default
      const videoTitle = videoSource?.title || 'video-with-subtitles';
      downloadVideo(renderedVideoUrl, `${videoTitle}.webm`);
    } catch (err) {
      console.error('Error rendering subtitles:', err);
      setError(t('videoPreview.renderError', 'Error rendering subtitles: {{error}}', { error: err.message }));
    } finally {
      setIsRenderingVideo(false);
    }
  };

  // Handle downloading video with translated subtitles
  const handleDownloadWithTranslatedSubtitles = async () => {
    if (!videoUrl || !translatedSubtitles || translatedSubtitles.length === 0) {
      setError(t('videoPreview.noTranslatedSubtitles', 'No translated subtitles available'));
      return;
    }

    setIsRenderingVideo(true);
    setRenderProgress(0);
    setError('');

    try {
      // Convert translatedSubtitles to the format expected by renderSubtitlesToVideo
      // Use original subtitle timings when available
      const formattedSubtitles = translatedSubtitles.map(sub => {
        // If this subtitle has an originalId, find the corresponding original subtitle
        if (sub.originalId && subtitlesArray) {
          const originalSub = subtitlesArray.find(s => s.id === sub.originalId);
          if (originalSub) {
            // Use the original subtitle's timing
            return {
              id: sub.id,
              start: originalSub.start,
              end: originalSub.end,
              text: sub.text
            };
          }
        }

        // If the subtitle already has start/end properties, use them
        if (sub.start !== undefined && sub.end !== undefined) {
          return sub;
        }

        // Otherwise, convert from startTime/endTime format
        return {
          id: sub.id,
          start: typeof sub.startTime === 'string' ? convertTimeStringToSeconds(sub.startTime) : 0,
          end: typeof sub.endTime === 'string' ? convertTimeStringToSeconds(sub.endTime) : 0,
          text: sub.text
        };
      });

      const renderedVideoUrl = await renderSubtitlesToVideo(
        videoUrl,
        formattedSubtitles,
        subtitleSettings,
        (progress) => setRenderProgress(progress)
      );

      // Get video title or use default
      const videoTitle = videoSource?.title || 'video-with-translated-subtitles';
      downloadVideo(renderedVideoUrl, `${videoTitle}.webm`);
    } catch (err) {
      console.error('Error rendering translated subtitles:', err);
      setError(t('videoPreview.renderError', 'Error rendering subtitles: {{error}}', { error: err.message }));
    } finally {
      setIsRenderingVideo(false);
    }
  };

  return (
    <div className="video-preview">
      {/* CSS Animation for spinner and hide native controls */}
      <style>
        {`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }

          /* Force hide native video controls in all states including fullscreen */
          .video-player::-webkit-media-controls {
            display: none !important;
          }
          .video-player::-webkit-media-controls-panel {
            display: none !important;
          }
          .video-player::-webkit-media-controls-play-button {
            display: none !important;
          }
          .video-player::-webkit-media-controls-timeline {
            display: none !important;
          }
          .video-player::-webkit-media-controls-current-time-display {
            display: none !important;
          }
          .video-player::-webkit-media-controls-time-remaining-display {
            display: none !important;
          }
          .video-player::-webkit-media-controls-mute-button {
            display: none !important;
          }
          .video-player::-webkit-media-controls-volume-slider {
            display: none !important;
          }
          .video-player::-webkit-media-controls-fullscreen-button {
            display: none !important;
          }
          .video-player::-webkit-media-controls-overlay-play-button {
            display: none !important;
          }

          /* Firefox */
          .video-player::-moz-media-controls {
            display: none !important;
          }

          /* Edge/IE */
          .video-player::-ms-media-controls {
            display: none !important;
          }

          /* Additional fallback */
          .video-player {
            outline: none !important;
          }
          .video-player:focus {
            outline: none !important;
          }

          /* Fullscreen container styling - remove centering */
          .native-video-container:fullscreen {
            width: 100vw !important;
            height: 100vh !important;
            background: black !important;
            position: relative !important;
            display: block !important;
            padding: 0 !important;
            margin: 0 !important;
          }

          .native-video-container:-webkit-full-screen {
            width: 100vw !important;
            height: 100vh !important;
            background: black !important;
            position: relative !important;
            display: block !important;
            padding: 0 !important;
            margin: 0 !important;
          }

          .native-video-container:-moz-full-screen {
            width: 100vw !important;
            height: 100vh !important;
            background: black !important;
            position: relative !important;
            display: block !important;
            padding: 0 !important;
            margin: 0 !important;
          }

          .native-video-container:-ms-fullscreen {
            width: 100vw !important;
            height: 100vh !important;
            background: black !important;
            position: relative !important;
            display: block !important;
            padding: 0 !important;
            margin: 0 !important;
          }

          /* Video in fullscreen - use transform scale approach */
          .native-video-container:fullscreen .video-player,
          .native-video-container:-webkit-full-screen .video-player,
          .native-video-container:-moz-full-screen .video-player,
          .native-video-container:-ms-fullscreen .video-player {
            width: 100vw !important;
            height: 100vh !important;
            max-width: none !important;
            max-height: none !important;
            min-width: 100vw !important;
            min-height: 100vh !important;
            object-fit: contain !important;
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            z-index: 1000 !important;
            transform: none !important;
          }

          /* Video wrapper in fullscreen */
          .native-video-container:fullscreen .video-wrapper,
          .native-video-container:-webkit-full-screen .video-wrapper,
          .native-video-container:-moz-full-screen .video-wrapper,
          .native-video-container:-ms-fullscreen .video-wrapper {
            width: 100vw !important;
            height: 100vh !important;
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            z-index: 1 !important;
          }

          /* Force video element to fill in fullscreen - multiple selectors for maximum coverage */
          .native-video-container:fullscreen video,
          .native-video-container:-webkit-full-screen video,
          .native-video-container:-moz-full-screen video,
          .native-video-container:-ms-fullscreen video,
          .native-video-container:fullscreen .video-player,
          .native-video-container:-webkit-full-screen .video-player,
          .native-video-container:-moz-full-screen .video-player,
          .native-video-container:-ms-fullscreen .video-player {
            width: 100vw !important;
            height: 100vh !important;
            object-fit: contain !important;
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            z-index: 1000 !important;
            transform: none !important;
            max-width: none !important;
            max-height: none !important;
            min-width: 100vw !important;
            min-height: 100vh !important;
            cursor: pointer !important;
            touch-action: manipulation !important;
          }
        `}
      </style>

      {/* Narration Settings moved to unified component in translation section */}

      <div className="video-preview-header">
        <h3>{t('output.videoPreview', 'Video Preview with Subtitles')}</h3>
        <SubtitleSettings
          settings={subtitleSettings}
          onSettingsChange={setSubtitleSettings}
          onDownloadWithSubtitles={handleDownloadWithSubtitles}
          onDownloadWithTranslatedSubtitles={handleDownloadWithTranslatedSubtitles}
          hasTranslation={translatedSubtitles && translatedSubtitles.length > 0}
          translatedSubtitles={translatedSubtitles}
          targetLanguage={translatedSubtitles && translatedSubtitles.length > 0 && translatedSubtitles[0].language}
          videoRef={videoRef}
          originalNarrations={window.originalNarrations || (() => {
            try {
              const stored = localStorage.getItem('originalNarrations');
              return stored ? JSON.parse(stored) : [];
            } catch (e) {
              console.error('Error parsing originalNarrations from localStorage:', e);
              return [];
            }
          })()}
          translatedNarrations={window.translatedNarrations || (() => {
            try {
              const stored = localStorage.getItem('translatedNarrations');
              return stored ? JSON.parse(stored) : [];
            } catch (e) {
              console.error('Error parsing translatedNarrations from localStorage:', e);
              return [];
            }
          })()}
          {...(() => {
            // Store subtitles data in window for access by other components
            if (subtitlesArray && subtitlesArray.length > 0) {
              window.subtitlesData = subtitlesArray;
              // Only log in development mode
              if (process.env.NODE_ENV === 'development' && !window._loggedSubtitlesData) {

                window._loggedSubtitlesData = true;
              }
            }
            // Store original subtitles (same as subtitlesArray in this context)
            if (subtitlesArray && subtitlesArray.length > 0) {
              window.originalSubtitles = subtitlesArray;
              // Only log in development mode
              if (process.env.NODE_ENV === 'development' && !window._loggedOriginalSubtitles) {

                window._loggedOriginalSubtitles = true;
              }
            }
            // Store translated subtitles if available
            if (translatedSubtitles && translatedSubtitles.length > 0) {
              window.translatedSubtitles = translatedSubtitles;
              // Only log in development mode
              if (process.env.NODE_ENV === 'development' && !window._loggedTranslatedSubtitles) {

                window._loggedTranslatedSubtitles = true;
              }
            }
            return {};
          })()}
          getAudioUrl={(filename) => `${SERVER_URL}/narration/audio/${filename || 'test.wav'}`}
          onRenderVideo={onRenderVideo}
          volume={volume}
          setVolume={setVolume}
        />
      </div>

      {isRenderingVideo && (
        <div className="rendering-overlay">
          <div className="rendering-progress">
            <div className="progress-bar" style={{ width: `${renderProgress * 100}%` }}></div>
          </div>
          <div className="rendering-text">
            {t('videoPreview.rendering', 'Rendering video with subtitles...')} ({Math.round(renderProgress * 100)}%)
          </div>
        </div>
      )}

      <div className="video-container">
        {error && <div className="error">{error}</div>}

        {/* Only show downloading UI if we're actually downloading and have progress > 0 */}
        {isDownloading && downloadProgress > 0 && (
          <div className="video-downloading">
            <div className="download-progress">
              <div className="progress-bar" style={{ width: `${downloadProgress}%` }}></div>
            </div>
            <div className="download-text">
              {t('preview.downloading', 'Downloading video...')} ({downloadProgress}%)
            </div>
          </div>
        )}

        {/* Always show video player if we have a URL, regardless of download state */}
        {videoUrl ? (
          <div
            ref={videoContainerRef}
            className="native-video-container"
            onMouseEnter={() => !isFullscreen && setIsVideoHovered(true)}
            onMouseLeave={() => !isFullscreen && setIsVideoHovered(false)}
          >
              {/* Video quality toggle - only show when optimized video is available */}




              <div className="video-wrapper" style={{ position: 'relative' }}>
                {/* Topside buttons component */}
                <VideoTopsideButtons
                  showCustomControls={showCustomControls}
                  isFullscreen={isFullscreen}
                  controlsVisible={controlsVisible}
                  isVideoHovered={isVideoHovered}
                  isRefreshingNarration={isRefreshingNarration}
                  setIsRefreshingNarration={setIsRefreshingNarration}
                  isAudioDownloading={isAudioDownloading}
                  setIsAudioDownloading={setIsAudioDownloading}
                  setError={setError}
                  videoRef={videoRef}
                  videoSource={videoSource}
                  fileType={fileType}
                  useOptimizedPreview={useOptimizedPreview}
                  optimizedVideoUrl={optimizedVideoUrl}
                  videoUrl={videoUrl}
                />

                <video
                  ref={videoRef}
                  className="video-player"
                  onClick={() => {
                    if (videoRef.current) {
                      if (isPlaying) {
                        videoRef.current.pause();
                      } else {
                        videoRef.current.play().catch(console.error);
                      }

                      // Force sync UI state after a short delay to ensure it matches video state
                      setTimeout(() => {
                        const actuallyPlaying = !videoRef.current.paused;
                        if (actuallyPlaying !== isPlaying) {
                          setIsPlaying(actuallyPlaying);
                        }
                      }, 50);
                    }
                  }}
                  onTouchEnd={(e) => {
                    // Prevent double-tap zoom on mobile
                    e.preventDefault();
                    const now = Date.now();
                    if (now - lastTouchTimeRef.current < 300) { // double tap
                      const rect = e.target.getBoundingClientRect();
                      const touch = e.changedTouches[0];
                      const x = touch.clientX - rect.left;
                      const isLeft = x < rect.width / 2;
                      if (videoRef.current) {
                        if (isLeft) {
                          videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 5);
                        } else {
                          if (videoRef.current.duration) {
                            videoRef.current.currentTime = Math.min(videoRef.current.duration, videoRef.current.currentTime + 5);
                          }
                        }
                      }
                      handleSeek(isLeft ? 'backward' : 'forward');
                    } else {
                      lastTouchTimeRef.current = now;
                      if (videoRef.current) {
                        if (isPlaying) {
                          videoRef.current.pause();
                        } else {
                          videoRef.current.play().catch(console.error);
                        }
                        // Force sync UI state after a short delay to ensure it matches video state
                        setTimeout(() => {
                          const actuallyPlaying = !videoRef.current.paused;
                          if (actuallyPlaying !== isPlaying) {
                            setIsPlaying(actuallyPlaying);
                          }
                        }, 50);
                      }
                    }
                  }}
                  style={{
                    cursor: 'pointer',
                    touchAction: 'manipulation',
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    display: 'block',
                    zIndex: 1
                  }}
                  playsInline
                  controlsList="nodownload nofullscreen noremoteplayback"
                  disablePictureInPicture={false}
                  src={useOptimizedPreview && optimizedVideoUrl ? optimizedVideoUrl : videoUrl}
                  crossOrigin="anonymous"
                  onError={(e) => {
                    console.error('Video error:', e);
                    // If optimized video fails to load, fall back to original video
                    if (useOptimizedPreview && optimizedVideoUrl && e.target.src === optimizedVideoUrl) {

                      e.target.src = videoUrl;
                      e.target.load();
                    }
                  }}
                >
                  <source
                    src={useOptimizedPreview && optimizedVideoUrl ? optimizedVideoUrl : videoUrl}
                    type="video/mp4"
                    onError={(e) => {
                      console.error('Source error:', e);
                      // If optimized video fails to load, fall back to original video
                      if (useOptimizedPreview && optimizedVideoUrl && e.target.src === optimizedVideoUrl) {

                        e.target.src = videoUrl;
                      }
                    }}
                  />

                  {/* Native track subtitles disabled - using only custom subtitle display */}

                  {t('preview.videoNotSupported', 'Your browser does not support the video tag.')}
                </video>

                {/* Custom subtitle display - positioned inside video-wrapper for proper layering */}
                <div className="custom-subtitle-container" style={{ width: `${subtitleSettings.boxWidth || '80'}%` }}>
                  {currentSubtitleText && (
                    <div className="custom-subtitle">
                      {currentSubtitleText.split('\n').map((line, index) => (
                        <React.Fragment key={index}>
                          {index > 0 && <br />}
                          {line}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>

                <SeekIndicator showSeekIndicator={showSeekIndicator} seekDirection={seekDirection} />

                {/* Loading/Buffering Spinner */}
                {(isVideoLoading || isBuffering) && (
                  <LoadingIndicator
                    theme="light"
                    showContainer={true}
                    size={60}
                    style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      zIndex: 15
                    }}
                  />
                )}

                {/* Bottom controls component */}
                <VideoBottomControls
                  showCustomControls={showCustomControls}
                  isFullscreen={isFullscreen}
                  controlsVisible={controlsVisible}
                  isVideoHovered={isVideoHovered}
                  isPlaying={isPlaying}
                  setIsPlaying={setIsPlaying}
                  videoRef={videoRef}
                  currentTime={currentTime}
                  videoDuration={videoDuration}
                  isDragging={isDragging}
                  dragTime={dragTime}
                  setIsDragging={setIsDragging}
                  setDragTime={setDragTime}
                  dragTimeRef={dragTimeRef}
                  bufferedProgress={bufferedProgress}
                  handleTimelineMouseDown={handleTimelineMouseDown}
                  handleTimelineTouchStart={handleTimelineTouchStart}
                  volume={volume}
                  setVolume={setVolume}
                  isMuted={isMuted}
                  setIsMuted={setIsMuted}
                  isVolumeSliderVisible={isVolumeSliderVisible}
                  setIsVolumeSliderVisible={setIsVolumeSliderVisible}
                  isVolumeDragging={isVolumeDragging}
                  setIsVolumeDragging={setIsVolumeDragging}
                  playbackSpeed={playbackSpeed}
                  setPlaybackSpeed={setPlaybackSpeed}
                  isSpeedMenuVisible={isSpeedMenuVisible}
                  setIsSpeedMenuVisible={setIsSpeedMenuVisible}
                  isCompactMode={isCompactMode}
                  handleFullscreenExit={handleFullscreenExit}
                  setIsFullscreen={setIsFullscreen}
                  setControlsVisible={setControlsVisible}
                  setIsVideoHovered={setIsVideoHovered}
                  hideControlsTimeoutRef={hideControlsTimeoutRef}
                  videoSource={videoSource}
                  fileType={fileType}
                />






                {/* Loading overlay for narration refresh */}
                {isRefreshingNarration && (
                  <div className="narration-refresh-overlay">
                    <div className="narration-refresh-content">
                      <LoadingIndicator
                        theme="light"
                        showContainer={false}
                        size={48}
                        className="narration-refresh-loading"
                      />
                      <div className="narration-refresh-text">
                        {t('preview.refreshingNarration', 'Refreshing narration...')}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Apply subtitle styling to the video element */}
              <style>
                {`
                  /* Set CSS variables for custom subtitle styling */
                  :root {
                    --subtitle-position: ${subtitleSettings.position || '90'}%;
                    --subtitle-box-width: ${subtitleSettings.boxWidth || '80'}%;
                    --subtitle-background-radius: ${subtitleSettings.backgroundRadius || '4'}px;
                    --subtitle-background-padding: ${subtitleSettings.backgroundPadding || '10'}px;
                    --subtitle-text-transform: ${subtitleSettings.textTransform || 'none'};
                    --subtitle-letter-spacing: ${subtitleSettings.letterSpacing || '0'}px;
                  }

                  /* Native track subtitles disabled - using only custom subtitle display */

                  /* Video container positioning */
                  .native-video-container {
                    position: relative;
                  }

                  /* Style for custom subtitle display */
                  .custom-subtitle-container {
                    position: absolute;
                    left: 0;
                    right: 0;
                    width: var(--subtitle-box-width);
                    max-width: 100%;
                    margin: 0 auto;
                    text-align: center;
                    z-index: 2; /* Above video (z-index: 1) but below UI controls (z-index: 3+) */
                    /* Calculate top position based on percentage (0% = top, 100% = bottom) */
                    bottom: calc(100% - var(--subtitle-position));
                    transform: translateY(16%);
                    pointer-events: none; /* Allow clicks to pass through to video and controls */
                  }

                  .custom-subtitle {
                    display: inline-block;
                    background-color: rgba(${parseInt(subtitleSettings.backgroundColor.slice(1, 3), 16)}, ${parseInt(subtitleSettings.backgroundColor.slice(3, 5), 16)}, ${parseInt(subtitleSettings.backgroundColor.slice(5, 7), 16)}, ${subtitleSettings.opacity});
                    color: ${subtitleSettings.textColor};
                    font-family: ${subtitleSettings.fontFamily};
                    font-variation-settings: ${subtitleSettings.fontVariationSettings || 'normal'};
                    font-size: ${subtitleSettings.fontSize}px;
                    font-weight: ${subtitleSettings.fontWeight};
                    line-height: ${subtitleSettings.lineSpacing || '1.4'};
                    text-align: ${subtitleSettings.textAlign || 'center'};
                    text-transform: var(--subtitle-text-transform);
                    letter-spacing: var(--subtitle-letter-spacing);
                    padding: ${subtitleSettings.backgroundPadding || '10'}px;
                    border-radius: ${subtitleSettings.backgroundRadius || '4'}px;
                    text-shadow: ${subtitleSettings.textShadow === true || subtitleSettings.textShadow === 'true' ? '1px 1px 2px rgba(0, 0, 0, 0.8)' : 'none'};
                    max-width: 100%;
                    word-wrap: break-word;
                  }

                `}
              </style>


            </div>
          ) : null}

      </div>
    </div>
  );
};

export default VideoPreview;

