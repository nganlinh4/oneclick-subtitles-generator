import { useEffect, useRef } from 'react';
import { releaseNativeNarrationPlayback } from '../../../platform/nativeNarrationArtifacts';

/**
 * Custom hook for audio playback
 * @param {Object} params - Parameters
 * @param {boolean} params.isPlaying - Whether audio is playing
 * @param {Object} params.currentAudio - Current audio being played
 * @param {Function} params.setIsPlaying - Function to set playing state
 * @returns {Object} - Audio playback handlers and refs
 */
const useAudioPlayback = ({
  isPlaying,
  currentAudio,
  setIsPlaying,
  setCurrentAudio,
}) => {
  // Create audio ref
  const audioRef = useRef(null);
  const playbackRef = useRef(null);

  useEffect(() => {
    const previous = playbackRef.current;
    if (previous?.nativePlaybackId
        && previous.nativePlaybackId !== currentAudio?.nativePlaybackId) {
      releaseNativeNarrationPlayback(previous);
    }
    playbackRef.current = currentAudio;
  }, [currentAudio]);

  useEffect(() => () => {
    releaseNativeNarrationPlayback(playbackRef.current);
    playbackRef.current = null;
  }, []);

  // Handle audio playback
  useEffect(() => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.play();
      } else {
        audioRef.current.pause();
      }
    }
  }, [isPlaying, currentAudio]);

  // Handle audio ended event
  const handleAudioEnded = () => {
    setIsPlaying(false);
    if (currentAudio?.nativePlaybackId) {
      releaseNativeNarrationPlayback(currentAudio);
      playbackRef.current = null;
      if (typeof setCurrentAudio === 'function') setCurrentAudio(null);
    }
  };

  return {
    audioRef,
    handleAudioEnded
  };
};

export default useAudioPlayback;
