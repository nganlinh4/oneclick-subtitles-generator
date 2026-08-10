import { useState, useEffect, useRef } from 'react';

/**
 * Hook encapsulating uploaded-SRT tracking with localStorage persistence.
 *
 * Behavior matches the original inline implementation in ButtonsContainer.jsx
 * byte-for-byte; state/setters are threaded in via params.
 */
export const useSrtUploadState = ({
  subtitlesData,
  setSubtitlesData,
  status,
  isSrtOnlyMode,
  isGenerating,
  handleSrtUpload,
  handleUserSubtitlesAdd
}) => {
  // State for tracking uploaded SRT files with localStorage persistence
  const [uploadedSrtInfo, setUploadedSrtInfo] = useState(() => {
    try {
      const saved = localStorage.getItem('uploaded_srt_info');
      return saved ? JSON.parse(saved) : {
        hasUploaded: false,
        fileName: '',
        source: '' // 'srt' or 'generated'
      };
    } catch (error) {
      return {
        hasUploaded: false,
        fileName: '',
        source: ''
      };
    }
  });
  const initialDetectionRef = useRef({
    subtitlesData,
    statusMessage: status?.message,
    isSrtOnlyMode,
    hasUploaded: uploadedSrtInfo.hasUploaded
  });

  // Persist uploadedSrtInfo to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('uploaded_srt_info', JSON.stringify(uploadedSrtInfo));
    } catch (error) {
      console.error('Error saving uploaded SRT info to localStorage:', error);
    }
  }, [uploadedSrtInfo]);

  // Initialize SRT upload detection on component mount
  useEffect(() => {
    // On initial load, check if we should detect existing SRT data
    const initial = initialDetectionRef.current;
    if (initial.subtitlesData && initial.subtitlesData.length > 0 && !initial.hasUploaded) {
      // Check multiple indicators that this might be uploaded SRT data
      const isLikelySrtData = initial.isSrtOnlyMode ||
                             initial.statusMessage?.includes('SRT') ||
                             initial.statusMessage?.includes('uploaded') ||
                             initial.statusMessage?.includes('Working with SRT only') ||
                             // Check if subtitles have sequential IDs (typical of SRT files)
                             (initial.subtitlesData.length > 1 && initial.subtitlesData.every((sub, index) => sub.id === index + 1));

      if (isLikelySrtData) {
        setUploadedSrtInfo({
          hasUploaded: true,
          fileName: 'uploaded-file.srt', // Default name since we don't know the original
          source: 'srt'
        });
      }
    }
  }, []); // Run only once on mount

  // Track when subtitles come from SRT upload vs generation
  useEffect(() => {
    // Check if we have subtitles and determine their source
    if (subtitlesData && subtitlesData.length > 0) {
      // Multiple ways to detect SRT upload:
      // 1. Recent status message contains upload keywords
      const isFromRecentSrtUpload = status?.message?.includes('uploaded') ||
                                    status?.message?.includes('SRT') ||
                                    status?.message?.includes('JSON');

      // 2. We're in SRT-only mode (indicates subtitles without video generation)
      const isInSrtOnlyMode = isSrtOnlyMode;

      // 3. Status message indicates SRT-only mode
      const isSrtOnlyModeStatus = status?.message?.includes('Working with SRT only') ||
                                  status?.message?.includes('SRT only');

      // 4. Check if subtitles have the structure typical of uploaded SRT files
      // (they usually have sequential IDs and proper timing)
      const hasSequentialIds = subtitlesData.length > 1 &&
                               subtitlesData.every((sub, index) => sub.id === index + 1);

      // 5. Check if we have subtitles but no generation activity (likely uploaded)
      const hasSubtitlesWithoutGeneration = subtitlesData.length > 0 && !isGenerating &&
                                           !status?.message?.includes('Processing') &&
                                           !status?.message?.includes('Generating');

      const isFromSrtUpload = isFromRecentSrtUpload || isInSrtOnlyMode || isSrtOnlyModeStatus ||
                             (hasSubtitlesWithoutGeneration && hasSequentialIds);

      if (isFromSrtUpload && !uploadedSrtInfo.hasUploaded) {
        // This is a new SRT upload or we detected existing SRT data
        setUploadedSrtInfo(prev => ({
          ...prev,
          hasUploaded: true,
          source: 'srt'
        }));
      } else if (!isFromSrtUpload && !isInSrtOnlyMode && uploadedSrtInfo.source === 'srt') {
        // Subtitles were regenerated and we're not in SRT-only mode, clear SRT upload state
        setUploadedSrtInfo({
          hasUploaded: false,
          fileName: '',
          source: 'generated'
        });
      }
    } else {
      // No subtitles, clear upload state
      setUploadedSrtInfo({
        hasUploaded: false,
        fileName: '',
        source: ''
      });
    }
  }, [subtitlesData, status, isSrtOnlyMode, isGenerating, uploadedSrtInfo.hasUploaded, uploadedSrtInfo.source]);

  // Enhanced SRT upload handler
  const handleSrtUploadWithState = (content, fileName) => {
    setUploadedSrtInfo({
      hasUploaded: true,
      fileName: fileName,
      source: 'srt'
    });
    handleSrtUpload(content, fileName);
  };

  // Clear SRT handler
  const handleSrtClear = () => {
    const clearedInfo = {
      hasUploaded: false,
      fileName: '',
      source: ''
    };
    setUploadedSrtInfo(clearedInfo);

    // Clear from localStorage as well
    try {
      localStorage.setItem('uploaded_srt_info', JSON.stringify(clearedInfo));
    } catch (error) {
      console.error('Error clearing uploaded SRT info from localStorage:', error);
    }

    // Clear subtitles data - this should clear the subtitles completely
    if (typeof handleUserSubtitlesAdd === 'function') {
      handleUserSubtitlesAdd('');
    }

    // Also clear subtitles data directly if available
    if (typeof setSubtitlesData === 'function') {
      setSubtitlesData(null);
    }
  };

  return {
    uploadedSrtInfo,
    setUploadedSrtInfo,
    handleSrtUploadWithState,
    handleSrtClear
  };
};

export default useSrtUploadState;
