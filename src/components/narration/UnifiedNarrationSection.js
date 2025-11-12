import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getAudioUrl } from '../../services/narrationService';
import { showErrorToast, showInfoToast } from '../../utils/toastUtils';
import useNarrationHandlers from './hooks/useNarrationHandlers';

// Import custom hooks
import useNarrationState from './hooks/useNarrationState';
import useAvailabilityCheck from './hooks/useAvailabilityCheck';
import useGeminiNarration from './hooks/useGeminiNarration';
import useChatterboxNarration from './hooks/useChatterboxNarration';
import useEdgeTTSNarration from './hooks/useEdgeTTSNarration';
import useGTTSNarration from './hooks/useGTTSNarration';
import useAudioPlayback from './hooks/useAudioPlayback';
import useNarrationStorage from './hooks/useNarrationStorage';
import useUIEffects from './hooks/useUIEffects';
import useNarrationCache from './hooks/useNarrationCache';
import useWindowStateManager from './hooks/useWindowStateManager';

// Import modular components
import ReferenceAudioSection from './components/ReferenceAudioSection';
import AudioControls from './components/AudioControls';
import SubtitleSourceSelection from './components/SubtitleSourceSelection';
import GeminiSubtitleSourceSelection from './components/GeminiSubtitleSourceSelection';
import ChatterboxControls from './components/ChatterboxControls';
import EdgeTTSControls from './components/EdgeTTSControls';
import GTTSControls from './components/GTTSControls';
import GeminiVoiceSelection from './components/GeminiVoiceSelection';
import GeminiConcurrentClientsSlider from './components/GeminiConcurrentClientsSlider';
import AdvancedSettingsToggle from './components/AdvancedSettingsToggle';
import GenerateButton from './components/GenerateButton';

import NarrationResults from './components/NarrationResults';
import GeminiNarrationResults from './components/GeminiNarrationResults';
import NarrationMethodSelection from './components/NarrationMethodSelection';

// Import styles
import '../../styles/narration/unifiedNarrationRedesign.css';

/**
 * Unified Narration Section component that combines settings and generation
 * @param {Object} props - Component props
 * @param {Array} props.subtitles - Subtitles to generate narration for (fallback)
 * @param {Array} props.originalSubtitles - Original subtitles
 * @param {Array} props.translatedSubtitles - Translated subtitles (optional)
 * @param {string} props.videoPath - Path to the current video (optional)
 * @param {Function} props.onReferenceAudioChange - Callback when reference audio changes
 * @param {Object} props.referenceAudio - Initial reference audio
 * @returns {JSX.Element} - Rendered component
 */
const UnifiedNarrationSection = ({
  subtitles,
  originalSubtitles,
  translatedSubtitles,
  videoPath,
  onReferenceAudioChange,
  referenceAudio: initialReferenceAudio
}) => {
  const { t } = useTranslation();

  // Refs
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const fileInputRef = useRef(null);
  const statusRef = useRef(null);
  const contentRef = useRef(null);
  const sectionRef = useRef(null);

  // Use custom hooks for state management
  const narrationState = useNarrationState(initialReferenceAudio);

  // Destructure state from the hook
  const {
    // Narration Method state
    narrationMethod, setNarrationMethod,
    isGeminiAvailable, setIsGeminiAvailable,
    isChatterboxAvailable, setIsChatterboxAvailable,

    // Gemini-specific settings
    selectedVoice, setSelectedVoice,
    concurrentClients, setConcurrentClients,

    // Chatterbox-specific settings
    exaggeration, setExaggeration,
    cfgWeight, setCfgWeight,
    chatterboxLanguage, setChatterboxLanguage,

    // Edge TTS-specific settings
    edgeTTSVoice, setEdgeTTSVoice,
    edgeTTSRate, setEdgeTTSRate,
    edgeTTSVolume, setEdgeTTSVolume,
    edgeTTSPitch, setEdgeTTSPitch,

    // gTTS-specific settings
    gttsLanguage, setGttsLanguage,
    gttsTld, setGttsTld,
    gttsSlow, setGttsSlow,

    // Narration Settings state (for F5-TTS)
    referenceAudio, setReferenceAudio,
    referenceText, setReferenceText,
    isRecording, setIsRecording,
    isStartingRecording, setIsStartingRecording,
    recordingStartTime, setRecordingStartTime,
    setRecordedAudio,
    isExtractingSegment, setIsExtractingSegment,
    segmentStartTime, segmentEndTime,
    autoRecognize, setAutoRecognize,
    isRecognizing, setIsRecognizing,

    // Narration Generation state
    isAvailable, setIsAvailable,
    isGenerating, setIsGenerating,
    generationStatus, setGenerationStatus,
    generationResults, setGenerationResults,
    error, setError,
    currentAudio, setCurrentAudio,
    isPlaying, setIsPlaying,
    subtitleSource, setSubtitleSource,
    advancedSettings, setAdvancedSettings,
    originalLanguage, setOriginalLanguage,
    translatedLanguage, setTranslatedLanguage,
    retryingSubtitleId, setRetryingSubtitleId,
    useGroupedSubtitles, setUseGroupedSubtitles,
    groupedSubtitles, setGroupedSubtitles,
    isGroupingSubtitles, setIsGroupingSubtitles,
    groupingIntensity, setGroupingIntensity,
    selectedNarrationModel,
    setSelectedNarrationModel,

    // Helper functions
    updateReferenceAudio
  } = narrationState;

  // Use availability check hook
  useAvailabilityCheck({
    narrationMethod,
    setIsAvailable,
    setIsGeminiAvailable,
    setIsChatterboxAvailable,
    setError,
    t
  });

  // Use Gemini narration hook
  const {
    handleGeminiNarration,
    cancelGeminiGeneration,
    retryGeminiNarration,
    retryFailedGeminiNarrations,
    generateAllPendingGeminiNarrations
  } = useGeminiNarration({
    setIsGenerating,
    setGenerationStatus,
    setError,
    setGenerationResults,
    generationResults,
    subtitleSource,
    originalSubtitles,
    translatedSubtitles,
    subtitles,
    originalLanguage,
    translatedLanguage,
    selectedVoice,
    concurrentClients,
    useGroupedSubtitles,
    setUseGroupedSubtitles,
    groupedSubtitles,
    setGroupedSubtitles,
    isGroupingSubtitles,
    setIsGroupingSubtitles,
    groupingIntensity,
    t,
    setRetryingSubtitleId
  });

  // Use Chatterbox narration hook
  const {
    handleChatterboxNarration,
    cancelChatterboxGeneration,
    retryChatterboxNarration,
    retryFailedChatterboxNarrations,
    generateAllPendingChatterboxNarrations
  } = useChatterboxNarration({
    setIsGenerating,
    setGenerationStatus,
    setError,
    setGenerationResults,
    generationResults,
    subtitleSource,
    originalSubtitles,
    translatedSubtitles,
    subtitles,
    originalLanguage,
    translatedLanguage,
    exaggeration,
    cfgWeight,
    chatterboxLanguage,
    referenceAudio,
    useGroupedSubtitles,
    setUseGroupedSubtitles,
    groupedSubtitles,
    setGroupedSubtitles,
    isGroupingSubtitles,
    setIsGroupingSubtitles,
    groupingIntensity,
    t,
    setRetryingSubtitleId,
    plannedSubtitles: (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0)
      ? groupedSubtitles
      : (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0)
        ? translatedSubtitles
        : (originalSubtitles || subtitles || [])
  });

  // Use Edge TTS narration hook
  const {
    handleEdgeTTSNarration,
    cancelEdgeTTSGeneration,
    retryEdgeTTSNarration,
    retryFailedEdgeTTSNarrations,
    generateAllPendingEdgeTTSNarrations
  } = useEdgeTTSNarration({
    setIsGenerating,
    setGenerationStatus,
    setError,
    setGenerationResults,
    generationResults,
    subtitleSource,
    originalSubtitles,
    translatedSubtitles,
    subtitles,
    originalLanguage,
    translatedLanguage,
    selectedVoice: edgeTTSVoice,
    setSelectedVoice: setEdgeTTSVoice,
    rate: edgeTTSRate,
    setRate: setEdgeTTSRate,
    volume: edgeTTSVolume,
    setVolume: setEdgeTTSVolume,
    pitch: edgeTTSPitch,
    setPitch: setEdgeTTSPitch,
    t,
    setRetryingSubtitleId,
    useGroupedSubtitles,
    groupedSubtitles,
    setUseGroupedSubtitles,
    plannedSubtitles: (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0)
      ? groupedSubtitles
      : (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0)
        ? translatedSubtitles
        : (originalSubtitles || subtitles || [])
  });

  // Use gTTS narration hook
  const {
    handleGTTSNarration,
    cancelGTTSGeneration,
    retryGTTSNarration,
    retryFailedGTTSNarrations,
    generateAllPendingGTTSNarrations
  } = useGTTSNarration({
    setIsGenerating,
    setGenerationStatus,
    setError,
    setGenerationResults,
    generationResults,
    subtitleSource,
    originalSubtitles,
    translatedSubtitles,
    subtitles,
    originalLanguage,
    translatedLanguage,
    selectedLanguage: gttsLanguage,
    setSelectedLanguage: setGttsLanguage,
    tld: gttsTld,
    setTld: setGttsTld,
    slow: gttsSlow,
    setSlow: setGttsSlow,
    t,
    setRetryingSubtitleId,
    useGroupedSubtitles,
    groupedSubtitles,
    setUseGroupedSubtitles,
    plannedSubtitles: (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0)
      ? groupedSubtitles
      : (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0)
        ? translatedSubtitles
        : (originalSubtitles || subtitles || [])
  });

  // Use audio playback hook
  const { audioRef, handleAudioEnded } = useAudioPlayback({
    isPlaying,
    currentAudio,
    setIsPlaying
  });

  // Use narration storage hook
  useNarrationStorage({
    generationResults,
    subtitleSource
  });

  // Use UI effects hook
  useUIEffects({
    isGenerating,
    generationStatus,
    statusRef,
    t,
    referenceAudio,
    segmentStartTime,
    segmentEndTime,
    setError
  });

  // Use narration cache hook
  useNarrationCache({
    generationResults,
    setGenerationResults,
    setGenerationStatus,
    subtitleSource,
    originalSubtitles,
    translatedSubtitles,
    subtitles,
    t,
    setReferenceAudio,
    setReferenceText
  });

  // Use window state manager hook
  useWindowStateManager({
    generationResults,
    subtitleSource,
    narrationMethod,
    originalSubtitles,
    translatedSubtitles,
    subtitles,
    useGroupedSubtitles,
    groupedSubtitles,
    setGroupedSubtitles,
    setIsGroupingSubtitles,
    setUseGroupedSubtitles,
    groupingIntensity
  });

  // Wrapper function for setReferenceText that also updates cache
  const setReferenceTextWithCache = (newText) => {
    setReferenceText(newText);

    // Update reference audio cache if we have reference audio
    if (referenceAudio) {
      try {
        const getCurrentMediaId = () => {
          const currentVideoUrl = localStorage.getItem('current_video_url');
          const currentFileUrl = localStorage.getItem('current_file_url');

          if (currentVideoUrl) {
            const match = currentVideoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            return match ? match[1] : null;
          } else if (currentFileUrl) {
            return localStorage.getItem('current_file_cache_id');
          }
          return null;
        };

        const mediaId = getCurrentMediaId();
        if (mediaId) {
          const referenceAudioCache = {
            mediaId,
            timestamp: Date.now(),
            referenceAudio: {
              filename: referenceAudio.filename,
              text: newText || '',
              url: referenceAudio.url,
              filepath: referenceAudio.filepath
            }
          };

          localStorage.setItem('reference_audio_cache', JSON.stringify(referenceAudioCache));
          console.log('Updated reference audio cache with new text');
        }
      } catch (error) {
        console.error('Error updating reference audio cache with new text:', error);
      }
    }
  };

  // Update reference audio when initialReferenceAudio changes
  useEffect(() => {
    updateReferenceAudio(initialReferenceAudio);
  }, [initialReferenceAudio, updateReferenceAudio]);

  // Reset UI state when switching narration methods, but preserve results for aligned narration
  useEffect(() => {
    // Clear status and error messages, but don't clear generation results
    // This ensures aligned narration can still access the results
    setGenerationStatus('');
    setError('');

    // Remove any generating classes
    if (sectionRef.current) {
      sectionRef.current.classList.remove('f5tts-generating', 'gemini-generating');
    }
  }, [narrationMethod, setGenerationStatus, setError]);

  // Dispatch toast notifications for errors
  useEffect(() => {
    if (error) {
      showErrorToast(error);
    }
  }, [error]);

  // Dispatch toast notifications for generation status
  useEffect(() => {
    if ((isGenerating || retryingSubtitleId) && generationStatus) {
      // Set different durations based on status message type
      let duration = 6000; // Default duration

      // 15 seconds for warming up and initializing messages
      if (generationStatus.includes('Warming up') || generationStatus.includes('initializingService') ||
          generationStatus.includes('Waking up')) {
        duration = 15000;
      }
      // 12 seconds for progress messages
      else if (generationStatus.includes('Generating') || generationStatus.includes('Generated') ||
               generationStatus.includes('chatterboxGeneratingProgress')) {
        duration = 12000;
      }

      showInfoToast(generationStatus, duration);
    }
  }, [generationStatus, isGenerating, retryingSubtitleId]);

  // No height animation when narration method changes - let content flow naturally

  // No overall section height animation - let content flow naturally

  // No special effect for height when generation starts - let content flow naturally

  // Import the handler functions from separate file to keep this component clean
  const {
    handleFileUpload,
    startRecording,
    stopRecording,
    // extractSegment is available but not used in this component
    clearReferenceAudio,
    handleGenerateNarration,
    playAudio,
    downloadAllAudio,
    downloadAlignedAudio,
    cancelGeneration,
    retryF5TTSNarration,
    retryFailedNarrations,
    generateAllPendingF5TTSNarrations,
    handleExampleSelect
  } = useNarrationHandlers({
    fileInputRef,
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
    getSelectedSubtitles: () => {
      // Check if we should use grouped subtitles
      if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
        return groupedSubtitles;
      }
      if (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0) {
        return translatedSubtitles;
      }
      return originalSubtitles || subtitles;
    },
    advancedSettings,
    setIsGenerating,
    isGenerating,
    setGenerationStatus,
    setGenerationResults,
    generationResults,
    currentAudio,
    setCurrentAudio,
    setIsPlaying,
    statusRef,
    t,
    subtitleSource,
    translatedSubtitles,
    isPlaying,
    selectedNarrationModel,
    originalLanguage,
    translatedLanguage,
    setRetryingSubtitleId,
    useGroupedSubtitles,
    setUseGroupedSubtitles,
    groupedSubtitles,
    narrationMethod
  });

  // Check if all narration services are unavailable
  // Edge TTS and gTTS are always available, so only show unavailable message if all 5 methods are unavailable
  const isEdgeTTSAvailable = true; // Edge TTS is always available
  const isGTTSAvailable = true; // gTTS is always available
  const allServicesUnavailable = !isAvailable && !isGeminiAvailable && !isChatterboxAvailable && !isEdgeTTSAvailable && !isGTTSAvailable;

  // Since Edge TTS and gTTS are always available, we should never show the unavailable section
  // This logic is kept for potential future cases where these services might become unavailable
  if (allServicesUnavailable) {
    return (
      <div className="narration-section unavailable" ref={sectionRef}>
        <div className="narration-header">
          <h3>
            {t('narration.title', 'Generate Narration')}
            <span className="service-unavailable">
              {t('narration.serviceUnavailableIndicator', '(Service Unavailable)')}
            </span>
          </h3>
        </div>
        <div className="narration-unavailable-message">
          <div className="warning-icon">
            <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>warning</span>
          </div>
          <div className="message">
            {t('narration.allServicesUnavailableMessage', "All narration services are unavailable. For F5-TTS and Chatterbox, please run with npm run dev:cuda. For Gemini, please check your API key in settings.")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="narration-section" ref={sectionRef}>
      <div className="narration-header">
        <h3>{t('narration.title', 'Generate Narration')}</h3>
        <p className="narration-description">
          {t('narration.description', 'Generate spoken audio from your subtitles using the reference voice.')}
        </p>
      </div>

      {/* Narration Method Selection */}
      <NarrationMethodSelection
        narrationMethod={narrationMethod}
        setNarrationMethod={setNarrationMethod}
        isGenerating={isGenerating}
        isF5Available={isAvailable}
        isChatterboxAvailable={isChatterboxAvailable}
        isGeminiAvailable={isGeminiAvailable}
        isEdgeTTSAvailable={true}
        isGTTSAvailable={true}
      />

      <div className="narration-content-container" ref={contentRef}>
      {narrationMethod === 'f5tts' ? (
        // F5-TTS UI
        <div className="f5tts-content">
          {/* Audio Controls */}
          <AudioControls
            handleFileUpload={handleFileUpload}
            fileInputRef={fileInputRef}
            isRecording={isRecording}
            isStartingRecording={isStartingRecording}
            recordingStartTime={recordingStartTime}
            startRecording={startRecording}
            stopRecording={stopRecording}
            isAvailable={isAvailable}
            referenceAudio={referenceAudio}
            clearReferenceAudio={clearReferenceAudio}
            onExampleSelect={handleExampleSelect}
            narrationMethod={narrationMethod}
          />

          {/* Reference Audio Section */}
          <ReferenceAudioSection
            referenceAudio={referenceAudio}
            autoRecognize={autoRecognize}
            setAutoRecognize={setAutoRecognize}
            isRecognizing={isRecognizing}
            referenceText={referenceText}
            setReferenceText={setReferenceTextWithCache}
            clearReferenceAudio={clearReferenceAudio}
            isRecording={isRecording}
            isExtractingSegment={isExtractingSegment}
          />

          {/* Subtitle Source Selection */}
          <SubtitleSourceSelection
            subtitleSource={subtitleSource}
            setSubtitleSource={setSubtitleSource}
            isGenerating={isGenerating}
            translatedSubtitles={translatedSubtitles}
            originalSubtitles={originalSubtitles || subtitles}
            originalLanguage={originalLanguage}
            translatedLanguage={translatedLanguage}
            setOriginalLanguage={setOriginalLanguage}
            setTranslatedLanguage={setTranslatedLanguage}
            useGroupedSubtitles={useGroupedSubtitles}
            setUseGroupedSubtitles={setUseGroupedSubtitles}
            isGroupingSubtitles={isGroupingSubtitles}
            groupedSubtitles={groupedSubtitles}
            groupingIntensity={groupingIntensity}
            setGroupingIntensity={setGroupingIntensity}
            narrationMethod={narrationMethod}
            selectedModel={selectedNarrationModel}
            setSelectedModel={setSelectedNarrationModel}
            onLanguageDetected={(source, language, modelId, modelError) => {


              if (modelError) {
                console.warn(`Model availability error: ${modelError}`);
              }

              // Update the selected narration model
              if (modelId) {
                setSelectedNarrationModel(modelId);

                // Save the automatically selected model to localStorage for future sessions
                try {
                  localStorage.setItem('last_used_narration_model', modelId);
                } catch (error) {
                  console.error('Error saving automatically selected narration model:', error);
                }
              }

              // Update the appropriate language state
              if (source === 'original') {
                setOriginalLanguage(language);
              } else if (source === 'translated') {
                setTranslatedLanguage(language);
              }

              // Store in localStorage for persistence
              try {
                localStorage.setItem('detected_language', JSON.stringify({
                  source,
                  language,
                  modelId,
                  modelError
                }));
              } catch (e) {
                console.error('Error storing detected language in localStorage:', e);
              }
            }}
          />

          {/* Advanced Settings Toggle */}
          <AdvancedSettingsToggle
            advancedSettings={advancedSettings}
            setAdvancedSettings={setAdvancedSettings}
            isGenerating={isGenerating}
          />

          {/* Generate Button */}
          <GenerateButton
            handleGenerateNarration={handleGenerateNarration}
            isGenerating={isGenerating}
            referenceAudio={referenceAudio}
            generationResults={generationResults}
            downloadAllAudio={downloadAllAudio}
            downloadAlignedAudio={downloadAlignedAudio}
            cancelGeneration={cancelGeneration}
            subtitleSource={subtitleSource}
            isServiceAvailable={isAvailable}
            serviceUnavailableMessage={t('narration.serviceUnavailableMessage', 'Vui lòng chạy ứng dụng bằng npm run dev:cuda để dùng chức năng Thuyết minh. Nếu đã chạy bằng npm run dev:cuda, vui lòng đợi khoảng 1 phút sẽ dùng được.')}
            narrationMethod="f5tts"
          />

          {/* Results */}
          <NarrationResults
            generationResults={generationResults}
            playAudio={playAudio}
            currentAudio={currentAudio}
            isPlaying={isPlaying}
            getAudioUrl={getAudioUrl}
            onRetry={retryF5TTSNarration}
            retryingSubtitleId={retryingSubtitleId}
            onRetryFailed={retryFailedNarrations}
            onGenerateAllPending={generateAllPendingF5TTSNarrations}
            subtitleSource={subtitleSource}
            isGenerating={isGenerating}
            plannedSubtitles={(useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0)
              ? groupedSubtitles
              : (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0)
                ? translatedSubtitles
                : (originalSubtitles || subtitles || [])}
          />

          {/* Hidden audio player for playback */}
          <audio
            ref={audioRef}
            src={currentAudio?.url}
            onEnded={handleAudioEnded}
            style={{ display: 'none' }}
          />
        </div>
      ) : narrationMethod === 'chatterbox' ? (
        // Chatterbox UI
        <div className="chatterbox-content">
          {/* Audio Controls - for reference audio upload */}
          <AudioControls
            handleFileUpload={handleFileUpload}
            fileInputRef={fileInputRef}
            isRecording={isRecording}
            isStartingRecording={isStartingRecording}
            recordingStartTime={recordingStartTime}
            startRecording={startRecording}
            stopRecording={stopRecording}
            isAvailable={isChatterboxAvailable}
            referenceAudio={referenceAudio}
            clearReferenceAudio={clearReferenceAudio}
            onExampleSelect={handleExampleSelect}
            narrationMethod={narrationMethod}
          />

          {/* Subtitle Source Selection - reuse from F5-TTS */}
          <SubtitleSourceSelection
            subtitleSource={subtitleSource}
            setSubtitleSource={setSubtitleSource}
            isGenerating={isGenerating}
            translatedSubtitles={translatedSubtitles}
            originalSubtitles={originalSubtitles || subtitles}
            originalLanguage={originalLanguage}
            translatedLanguage={translatedLanguage}
            setOriginalLanguage={setOriginalLanguage}
            setTranslatedLanguage={setTranslatedLanguage}
            useGroupedSubtitles={useGroupedSubtitles}
            setUseGroupedSubtitles={setUseGroupedSubtitles}
            isGroupingSubtitles={isGroupingSubtitles}
            groupedSubtitles={groupedSubtitles}
            groupingIntensity={groupingIntensity}
            setGroupingIntensity={setGroupingIntensity}
            onGroupedSubtitlesGenerated={setGroupedSubtitles}
            narrationMethod={narrationMethod}
            chatterboxLanguage={chatterboxLanguage}
            setChatterboxLanguage={setChatterboxLanguage}
            selectedModel={null}
            setSelectedModel={() => {}}
            onLanguageDetected={(source, language) => {
              if (source === 'original') {
                setOriginalLanguage(language);
              } else if (source === 'translated') {
                setTranslatedLanguage(language);
              }
            }}
          />

          {/* Chatterbox Controls */}
          <ChatterboxControls
            exaggeration={exaggeration}
            setExaggeration={setExaggeration}
            cfgWeight={cfgWeight}
            setCfgWeight={setCfgWeight}
            isGenerating={isGenerating}
            chatterboxLanguage={chatterboxLanguage}
          />

          {/* Generate Button - reuse from F5-TTS */}
          <GenerateButton
            handleGenerateNarration={handleChatterboxNarration}
            isGenerating={isGenerating}
            referenceAudio={referenceAudio}
            subtitleSource={subtitleSource}
            cancelGeneration={cancelChatterboxGeneration}
            downloadAllAudio={downloadAllAudio}
            downloadAlignedAudio={downloadAlignedAudio}
            generationResults={generationResults}
            isServiceAvailable={isChatterboxAvailable}
            serviceUnavailableMessage={t('narration.chatterboxUnavailableMessage', 'Chatterbox API is not available. Please start the Chatterbox service.')}
            narrationMethod="chatterbox"
          />

          {/* Chatterbox Results - reuse F5-TTS results component */}
           <NarrationResults
             generationResults={generationResults}
             onRetry={retryChatterboxNarration}
             retryingSubtitleId={retryingSubtitleId}
             onRetryFailed={retryFailedChatterboxNarrations}
             onGenerateAllPending={generateAllPendingChatterboxNarrations}
             hasGenerationError={!!error && error.includes('Chatterbox')}
             currentAudio={currentAudio}
             isPlaying={isPlaying}
             playAudio={playAudio}
             getAudioUrl={getAudioUrl}
             subtitleSource={subtitleSource}
             isGenerating={isGenerating}
             plannedSubtitles={(useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0)
               ? groupedSubtitles
               : (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0)
                 ? translatedSubtitles
                 : (originalSubtitles || subtitles || [])}
           />

          {/* Hidden audio player for playback */}
          <audio
            ref={audioRef}
            src={currentAudio?.url}
            onEnded={handleAudioEnded}
            style={{ display: 'none' }}
          />
        </div>
      ) : narrationMethod === 'edge-tts' ? (
        // Edge TTS UI
        <div className="edge-tts-content">
          {/* Subtitle Source Selection */}
          <SubtitleSourceSelection
            subtitleSource={subtitleSource}
            setSubtitleSource={setSubtitleSource}
            isGenerating={isGenerating}
            translatedSubtitles={translatedSubtitles}
            originalSubtitles={originalSubtitles || subtitles}
            originalLanguage={originalLanguage}
            translatedLanguage={translatedLanguage}
            setOriginalLanguage={setOriginalLanguage}
            setTranslatedLanguage={setTranslatedLanguage}
            useGroupedSubtitles={useGroupedSubtitles}
            setUseGroupedSubtitles={setUseGroupedSubtitles}
            isGroupingSubtitles={isGroupingSubtitles}
            groupedSubtitles={groupedSubtitles}
            groupingIntensity={groupingIntensity}
            setGroupingIntensity={setGroupingIntensity}
            onGroupedSubtitlesGenerated={setGroupedSubtitles}
            narrationMethod={narrationMethod}
            selectedModel={null}
            setSelectedModel={() => {}}
            onLanguageDetected={(source, language) => {
              if (source === 'original') {
                setOriginalLanguage(language);
              } else if (source === 'translated') {
                setTranslatedLanguage(language);
              }
            }}
          />

          {/* Edge TTS Controls */}
          <EdgeTTSControls
            selectedVoice={edgeTTSVoice}
            setSelectedVoice={setEdgeTTSVoice}
            rate={edgeTTSRate}
            setRate={setEdgeTTSRate}
            volume={edgeTTSVolume}
            setVolume={setEdgeTTSVolume}
            pitch={edgeTTSPitch}
            setPitch={setEdgeTTSPitch}
            isGenerating={isGenerating}
            detectedLanguage={subtitleSource === 'original' ? originalLanguage : translatedLanguage}
          />

          {/* Generate Button */}
          <GenerateButton
            handleGenerateNarration={handleEdgeTTSNarration}
            isGenerating={isGenerating}
            referenceAudio={null}
            subtitleSource={subtitleSource}
            cancelGeneration={cancelEdgeTTSGeneration}
            downloadAllAudio={downloadAllAudio}
            downloadAlignedAudio={downloadAlignedAudio}
            generationResults={generationResults}
            isServiceAvailable={true}
            serviceUnavailableMessage=""
          />

          {/* Edge TTS Results */}
           <NarrationResults
             generationResults={generationResults}
             onRetry={retryEdgeTTSNarration}
             retryingSubtitleId={retryingSubtitleId}
             onRetryFailed={retryFailedEdgeTTSNarrations}
             onGenerateAllPending={generateAllPendingEdgeTTSNarrations}
             hasGenerationError={!!error && error.includes('Edge TTS')}
             currentAudio={currentAudio}
             isPlaying={isPlaying}
             playAudio={playAudio}
             getAudioUrl={getAudioUrl}
             subtitleSource={subtitleSource}
             isGenerating={isGenerating}
             plannedSubtitles={(useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0)
               ? groupedSubtitles
               : (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0)
                 ? translatedSubtitles
                 : (originalSubtitles || subtitles || [])}
           />

          {/* Hidden audio player for playback */}
          <audio
            ref={audioRef}
            src={currentAudio?.url}
            onEnded={handleAudioEnded}
            style={{ display: 'none' }}
          />
        </div>
      ) : narrationMethod === 'gtts' ? (
        // gTTS UI
        <div className="gtts-content">
          {/* Subtitle Source Selection */}
          <SubtitleSourceSelection
            subtitleSource={subtitleSource}
            setSubtitleSource={setSubtitleSource}
            isGenerating={isGenerating}
            translatedSubtitles={translatedSubtitles}
            originalSubtitles={originalSubtitles || subtitles}
            originalLanguage={originalLanguage}
            translatedLanguage={translatedLanguage}
            setOriginalLanguage={setOriginalLanguage}
            setTranslatedLanguage={setTranslatedLanguage}
            useGroupedSubtitles={useGroupedSubtitles}
            setUseGroupedSubtitles={setUseGroupedSubtitles}
            isGroupingSubtitles={isGroupingSubtitles}
            groupedSubtitles={groupedSubtitles}
            groupingIntensity={groupingIntensity}
            setGroupingIntensity={setGroupingIntensity}
            onGroupedSubtitlesGenerated={setGroupedSubtitles}
            narrationMethod={narrationMethod}
            selectedModel={null}
            setSelectedModel={() => {}}
            onLanguageDetected={(source, language) => {
              if (source === 'original') {
                setOriginalLanguage(language);
              } else if (source === 'translated') {
                setTranslatedLanguage(language);
              }
            }}
          />

          {/* gTTS Controls */}
          <GTTSControls
            selectedLanguage={gttsLanguage}
            setSelectedLanguage={setGttsLanguage}
            tld={gttsTld}
            setTld={setGttsTld}
            slow={gttsSlow}
            setSlow={setGttsSlow}
            isGenerating={isGenerating}
            detectedLanguage={subtitleSource === 'original' ? originalLanguage : translatedLanguage}
          />

          {/* Generate Button */}
          <GenerateButton
            handleGenerateNarration={handleGTTSNarration}
            isGenerating={isGenerating}
            referenceAudio={null}
            subtitleSource={subtitleSource}
            cancelGeneration={cancelGTTSGeneration}
            downloadAllAudio={downloadAllAudio}
            downloadAlignedAudio={downloadAlignedAudio}
            generationResults={generationResults}
            isServiceAvailable={true}
            serviceUnavailableMessage=""
          />

          {/* gTTS Results */}
           <NarrationResults
             generationResults={generationResults}
             onRetry={retryGTTSNarration}
             retryingSubtitleId={retryingSubtitleId}
             onRetryFailed={retryFailedGTTSNarrations}
             onGenerateAllPending={generateAllPendingGTTSNarrations}
             hasGenerationError={!!error && error.includes('gTTS')}
             currentAudio={currentAudio}
             isPlaying={isPlaying}
             playAudio={playAudio}
             getAudioUrl={getAudioUrl}
             subtitleSource={subtitleSource}
             isGenerating={isGenerating}
             plannedSubtitles={(useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0)
               ? groupedSubtitles
               : (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0)
                 ? translatedSubtitles
                 : (originalSubtitles || subtitles || [])}
           />

          {/* Hidden audio player for playback */}
          <audio
            ref={audioRef}
            src={currentAudio?.url}
            onEnded={handleAudioEnded}
            style={{ display: 'none' }}
          />
        </div>
      ) : (
        // Gemini UI
        <div className="gemini-content">
          {/* Simplified Subtitle Source Selection for Gemini */}
          <GeminiSubtitleSourceSelection
            subtitleSource={subtitleSource}
            setSubtitleSource={setSubtitleSource}
            isGenerating={isGenerating}
            translatedSubtitles={translatedSubtitles}
            originalSubtitles={originalSubtitles || subtitles}
            originalLanguage={originalLanguage}
            translatedLanguage={translatedLanguage}
            setOriginalLanguage={setOriginalLanguage}
            setTranslatedLanguage={setTranslatedLanguage}
            useGroupedSubtitles={useGroupedSubtitles}
            setUseGroupedSubtitles={setUseGroupedSubtitles}
            isGroupingSubtitles={isGroupingSubtitles}
            groupedSubtitles={groupedSubtitles}
            groupingIntensity={groupingIntensity}
            setGroupingIntensity={setGroupingIntensity}
            onGroupedSubtitlesGenerated={setGroupedSubtitles}
            onLanguageDetected={(source, language) => {
              // Update the appropriate language state
              if (source === 'original') {
                setOriginalLanguage(language);
              } else if (source === 'translated') {
                setTranslatedLanguage(language);
              }
            }}
          />

          {/* Voice Selection for Gemini */}
          <GeminiVoiceSelection
            selectedVoice={selectedVoice}
            setSelectedVoice={setSelectedVoice}
            isGenerating={isGenerating}
          />

          {/* Concurrent Clients Slider for Gemini */}
          <GeminiConcurrentClientsSlider
            concurrentClients={concurrentClients}
            setConcurrentClients={setConcurrentClients}
            isGenerating={isGenerating}
          />

          {/* Generate Button */}
          <GenerateButton
            handleGenerateNarration={handleGeminiNarration}
            isGenerating={isGenerating}
            referenceAudio={null}
            subtitleSource={subtitleSource}
            cancelGeneration={cancelGeminiGeneration}
            downloadAllAudio={downloadAllAudio}
            downloadAlignedAudio={downloadAlignedAudio}
            generationResults={generationResults}
            isServiceAvailable={isGeminiAvailable}
            serviceUnavailableMessage={t('narration.geminiUnavailableMessage', 'Gemini API is not available. Please check your API key in settings.')}
          />

          {/* Gemini Results */}
          <GeminiNarrationResults
            generationResults={generationResults}
            onRetry={retryGeminiNarration}
            retryingSubtitleId={retryingSubtitleId}
            onRetryFailed={retryFailedGeminiNarrations}
            onGenerateAllPending={generateAllPendingGeminiNarrations}
            hasGenerationError={!!error && error.includes('Gemini')}
            subtitleSource={subtitleSource}
            plannedSubtitles={(useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0)
              ? groupedSubtitles
              : (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0)
                ? translatedSubtitles
                : (originalSubtitles || subtitles || [])}
          />

          {/* No need for a separate audio element here as it's included in the GeminiNarrationResults component */}
        </div>
      )}
      </div>
    </div>
  );
};

export default UnifiedNarrationSection;
