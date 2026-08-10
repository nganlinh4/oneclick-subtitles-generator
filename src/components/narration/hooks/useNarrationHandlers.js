import useAlignedDownload from './useAlignedDownload';
import useAudioIO from './useAudioIO';
import useNarrationDownloads from './useNarrationDownloads';

/**
 * Composes native reference I/O, playback, export, alignment, and generation handlers.
 * The render layer keeps its established handler surface while transport ownership stays
 * entirely in typed Tauri adapters.
 */
const useNarrationHandlers = ({
  mediaRecorderRef,
  audioChunksRef,
  referenceAudio,
  referenceText,
  setReferenceAudio,
  setReferenceText,
  setRecordedAudio,
  setIsRecording,
  setIsStartingRecording,
  setRecordingStartTime,
  setIsExtractingSegment,
  setIsRecognizing,
  setError,
  autoRecognize,
  segmentStartTime,
  segmentEndTime,
  videoPath,
  onReferenceAudioChange,
  generationResults,
  currentAudio,
  setCurrentAudio,
  setIsPlaying,
  t,
  isPlaying,
  narrationMethod,
  nativeNarrationHandlers,
}) => {
  const audioHandlers = useAudioIO({
    mediaRecorderRef,
    audioChunksRef,
    referenceAudio,
    referenceText,
    setReferenceAudio,
    setReferenceText,
    setRecordedAudio,
    setIsRecording,
    setIsStartingRecording,
    setRecordingStartTime,
    setIsExtractingSegment,
    setIsRecognizing,
    setError,
    autoRecognize,
    segmentStartTime,
    segmentEndTime,
    videoPath,
    onReferenceAudioChange,
    t,
    narrationMethod,
  });

  const { playAudio, downloadAllAudio } = useNarrationDownloads({
    generationResults,
    currentAudio,
    setCurrentAudio,
    isPlaying,
    setIsPlaying,
    t,
  });
  const { downloadAlignedAudio } = useAlignedDownload({ generationResults, t });

  return {
    ...audioHandlers,
    handleGenerateNarration: nativeNarrationHandlers.handleGenerateNarration,
    playAudio,
    downloadAllAudio,
    downloadAlignedAudio,
    cancelGeneration: nativeNarrationHandlers.cancelGeneration,
    retryF5TTSNarration: nativeNarrationHandlers.retryF5TTSNarration,
    retryFailedNarrations: nativeNarrationHandlers.retryFailedNarrations,
    generateAllPendingF5TTSNarrations:
      nativeNarrationHandlers.generateAllPendingF5TTSNarrations,
  };
};

export default useNarrationHandlers;
