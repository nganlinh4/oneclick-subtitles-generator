import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import useUnifiedNarration from './hooks/useUnifiedNarration';

// Import modular components
import NarrationMethodSelection from './components/NarrationMethodSelection';

// Import per-method section components
import F5TTSNarrationSection from './sections/F5TTSNarrationSection';
import ChatterboxNarrationSection from './sections/ChatterboxNarrationSection';
import GeminiNarrationSection from './sections/GeminiNarrationSection';
import EdgeTTSNarrationSection from './sections/EdgeTTSNarrationSection';
import GTTSNarrationSection from './sections/GTTSNarrationSection';

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

  // All narration state, generation hooks, side-effects and handlers live in this hook
  const {
    // Method state
    narrationMethod, setNarrationMethod,
    isGeminiAvailable, isChatterboxAvailable,
    isEdgeTTSAvailable, isGTTSAvailable,
    isAvailable,
    allServicesUnavailable,
    geminiUnavailableReason,

    // Gemini settings
    selectedVoice, setSelectedVoice,
    concurrentClients, setConcurrentClients,

    // Chatterbox settings
    exaggeration, setExaggeration,
    cfgWeight, setCfgWeight,
    chatterboxLanguage, setChatterboxLanguage,

    // Edge TTS settings
    edgeTTSVoice, setEdgeTTSVoice,
    edgeTTSRate, setEdgeTTSRate,
    edgeTTSVolume, setEdgeTTSVolume,
    edgeTTSPitch, setEdgeTTSPitch,

    // gTTS settings
    gttsLanguage, setGttsLanguage,
    gttsTld, setGttsTld,
    gttsSlow, setGttsSlow,

    // F5-TTS reference settings
    referenceAudio,
    referenceText,
    isRecording,
    isStartingRecording,
    recordingStartTime,
    isExtractingSegment,
    autoRecognize, setAutoRecognize,
    isRecognizing,

    // Generation state
    isGenerating,
    generationResults,
    error,
    currentAudio,
    isPlaying,
    subtitleSource, setSubtitleSource,
    advancedSettings, setAdvancedSettings,
    originalLanguage, setOriginalLanguage,
    translatedLanguage, setTranslatedLanguage,
    retryingSubtitleId,
    useGroupedSubtitles, setUseGroupedSubtitles,
    groupedSubtitles, setGroupedSubtitles,
    isGroupingSubtitles, setIsGroupingSubtitles,
    groupingIntensity, setGroupingIntensity,
    selectedNarrationModel, setSelectedNarrationModel,
    setReferenceTextWithCache,

    // Gemini handlers
    handleGeminiNarration,
    cancelGeminiGeneration,
    retryGeminiNarration,
    retryFailedGeminiNarrations,
    generateAllPendingGeminiNarrations,

    // Chatterbox handlers
    handleChatterboxNarration,
    cancelChatterboxGeneration,
    retryChatterboxNarration,
    retryFailedChatterboxNarrations,
    generateAllPendingChatterboxNarrations,

    // Edge TTS handlers
    handleEdgeTTSNarration,
    cancelEdgeTTSGeneration,
    retryEdgeTTSNarration,
    retryFailedEdgeTTSNarrations,
    generateAllPendingEdgeTTSNarrations,

    // gTTS handlers
    handleGTTSNarration,
    cancelGTTSGeneration,
    retryGTTSNarration,
    retryFailedGTTSNarrations,
    generateAllPendingGTTSNarrations,

    // Audio playback
    audioRef, handleAudioEnded,

    // F5-TTS / shared handlers
    handleFileUpload,
    startRecording,
    stopRecording,
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
  } = useUnifiedNarration({
    subtitles,
    originalSubtitles,
    translatedSubtitles,
    videoPath,
    onReferenceAudioChange,
    initialReferenceAudio,
    t,
    fileInputRef,
    mediaRecorderRef,
    audioChunksRef,
    statusRef,
    sectionRef
  });

  const engineUnavailableMessage = t(
    'narration.engineUnavailableMessage',
    'This narration engine is not ready. Install or start it in Settings > Tools.'
  );
  const geminiCredentialUnavailableMessage = t(
    'narration.geminiCredentialUnavailableMessage',
    'Gemini narration needs a usable API key. Add or replace one in Settings > API Keys.'
  );
  const geminiUnavailableMessage = geminiUnavailableReason === 'credential'
    ? geminiCredentialUnavailableMessage
    : engineUnavailableMessage;
  const allServicesUnavailableMessage = geminiUnavailableReason === 'credential'
    ? t(
      'narration.allServicesUnavailableCredentialMessage',
      'Gemini narration needs a usable API key in Settings > API Keys. Other narration engines can be installed or started in Settings > Tools.'
    )
    : t(
      'narration.allServicesUnavailableMessage',
      'All narration engines are unavailable. Install or start one in Settings > Tools.'
    );

  if (allServicesUnavailable) {
    return (
      <div className="narration-section setup-required" ref={sectionRef}>
        <div className="narration-header">
          <h3>{t('narration.title', 'Generate Narration')}</h3>
        </div>
        <div className="narration-setup-message">
          <div className="setup-icon">
            <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>info</span>
          </div>
          <div className="message">
            {allServicesUnavailableMessage}
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
        geminiUnavailableMessage={geminiUnavailableMessage}
        isEdgeTTSAvailable={isEdgeTTSAvailable}
        isGTTSAvailable={isGTTSAvailable}
      />

      <div className="narration-content-container" ref={contentRef}>
      {narrationMethod === 'f5tts' ? (
        <F5TTSNarrationSection
          t={t}
          narrationMethod={narrationMethod}
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
          handleExampleSelect={handleExampleSelect}
          autoRecognize={autoRecognize}
          setAutoRecognize={setAutoRecognize}
          isRecognizing={isRecognizing}
          referenceText={referenceText}
          setReferenceTextWithCache={setReferenceTextWithCache}
          isExtractingSegment={isExtractingSegment}
          subtitleSource={subtitleSource}
          setSubtitleSource={setSubtitleSource}
          isGenerating={isGenerating}
          translatedSubtitles={translatedSubtitles}
          originalSubtitles={originalSubtitles}
          subtitles={subtitles}
          originalLanguage={originalLanguage}
          translatedLanguage={translatedLanguage}
          setOriginalLanguage={setOriginalLanguage}
          setTranslatedLanguage={setTranslatedLanguage}
          useGroupedSubtitles={useGroupedSubtitles}
          setUseGroupedSubtitles={setUseGroupedSubtitles}
          isGroupingSubtitles={isGroupingSubtitles}
          setIsGroupingSubtitles={setIsGroupingSubtitles}
          groupedSubtitles={groupedSubtitles}
          setGroupedSubtitles={setGroupedSubtitles}
          groupingIntensity={groupingIntensity}
          setGroupingIntensity={setGroupingIntensity}
          selectedNarrationModel={selectedNarrationModel}
          setSelectedNarrationModel={setSelectedNarrationModel}
          advancedSettings={advancedSettings}
          setAdvancedSettings={setAdvancedSettings}
          handleGenerateNarration={handleGenerateNarration}
          generationResults={generationResults}
          downloadAllAudio={downloadAllAudio}
          downloadAlignedAudio={downloadAlignedAudio}
          cancelGeneration={cancelGeneration}
          playAudio={playAudio}
          currentAudio={currentAudio}
          isPlaying={isPlaying}
          retryF5TTSNarration={retryF5TTSNarration}
          retryingSubtitleId={retryingSubtitleId}
          retryFailedNarrations={retryFailedNarrations}
          generateAllPendingF5TTSNarrations={generateAllPendingF5TTSNarrations}
          audioRef={audioRef}
          handleAudioEnded={handleAudioEnded}
        />
      ) : narrationMethod === 'chatterbox' ? (
        <ChatterboxNarrationSection
          t={t}
          narrationMethod={narrationMethod}
          handleFileUpload={handleFileUpload}
          fileInputRef={fileInputRef}
          isRecording={isRecording}
          isStartingRecording={isStartingRecording}
          recordingStartTime={recordingStartTime}
          startRecording={startRecording}
          stopRecording={stopRecording}
          isChatterboxAvailable={isChatterboxAvailable}
          referenceAudio={referenceAudio}
          clearReferenceAudio={clearReferenceAudio}
          handleExampleSelect={handleExampleSelect}
          subtitleSource={subtitleSource}
          setSubtitleSource={setSubtitleSource}
          isGenerating={isGenerating}
          translatedSubtitles={translatedSubtitles}
          originalSubtitles={originalSubtitles}
          subtitles={subtitles}
          originalLanguage={originalLanguage}
          translatedLanguage={translatedLanguage}
          setOriginalLanguage={setOriginalLanguage}
          setTranslatedLanguage={setTranslatedLanguage}
          useGroupedSubtitles={useGroupedSubtitles}
          setUseGroupedSubtitles={setUseGroupedSubtitles}
          isGroupingSubtitles={isGroupingSubtitles}
          setIsGroupingSubtitles={setIsGroupingSubtitles}
          groupedSubtitles={groupedSubtitles}
          setGroupedSubtitles={setGroupedSubtitles}
          groupingIntensity={groupingIntensity}
          setGroupingIntensity={setGroupingIntensity}
          chatterboxLanguage={chatterboxLanguage}
          setChatterboxLanguage={setChatterboxLanguage}
          exaggeration={exaggeration}
          setExaggeration={setExaggeration}
          cfgWeight={cfgWeight}
          setCfgWeight={setCfgWeight}
          handleChatterboxNarration={handleChatterboxNarration}
          generationResults={generationResults}
          downloadAllAudio={downloadAllAudio}
          downloadAlignedAudio={downloadAlignedAudio}
          cancelChatterboxGeneration={cancelChatterboxGeneration}
          playAudio={playAudio}
          currentAudio={currentAudio}
          isPlaying={isPlaying}
          retryChatterboxNarration={retryChatterboxNarration}
          retryingSubtitleId={retryingSubtitleId}
          retryFailedChatterboxNarrations={retryFailedChatterboxNarrations}
          generateAllPendingChatterboxNarrations={generateAllPendingChatterboxNarrations}
          error={error}
          audioRef={audioRef}
          handleAudioEnded={handleAudioEnded}
        />
      ) : narrationMethod === 'edge-tts' ? (
        <EdgeTTSNarrationSection
          narrationMethod={narrationMethod}
          isEdgeTTSAvailable={isEdgeTTSAvailable}
          subtitleSource={subtitleSource}
          setSubtitleSource={setSubtitleSource}
          isGenerating={isGenerating}
          translatedSubtitles={translatedSubtitles}
          originalSubtitles={originalSubtitles}
          subtitles={subtitles}
          originalLanguage={originalLanguage}
          translatedLanguage={translatedLanguage}
          setOriginalLanguage={setOriginalLanguage}
          setTranslatedLanguage={setTranslatedLanguage}
          useGroupedSubtitles={useGroupedSubtitles}
          setUseGroupedSubtitles={setUseGroupedSubtitles}
          isGroupingSubtitles={isGroupingSubtitles}
          setIsGroupingSubtitles={setIsGroupingSubtitles}
          groupedSubtitles={groupedSubtitles}
          setGroupedSubtitles={setGroupedSubtitles}
          groupingIntensity={groupingIntensity}
          setGroupingIntensity={setGroupingIntensity}
          edgeTTSVoice={edgeTTSVoice}
          setEdgeTTSVoice={setEdgeTTSVoice}
          edgeTTSRate={edgeTTSRate}
          setEdgeTTSRate={setEdgeTTSRate}
          edgeTTSVolume={edgeTTSVolume}
          setEdgeTTSVolume={setEdgeTTSVolume}
          edgeTTSPitch={edgeTTSPitch}
          setEdgeTTSPitch={setEdgeTTSPitch}
          handleEdgeTTSNarration={handleEdgeTTSNarration}
          generationResults={generationResults}
          downloadAllAudio={downloadAllAudio}
          downloadAlignedAudio={downloadAlignedAudio}
          cancelEdgeTTSGeneration={cancelEdgeTTSGeneration}
          retryEdgeTTSNarration={retryEdgeTTSNarration}
          retryingSubtitleId={retryingSubtitleId}
          retryFailedEdgeTTSNarrations={retryFailedEdgeTTSNarrations}
          generateAllPendingEdgeTTSNarrations={generateAllPendingEdgeTTSNarrations}
          error={error}
          playAudio={playAudio}
          currentAudio={currentAudio}
          isPlaying={isPlaying}
          audioRef={audioRef}
          handleAudioEnded={handleAudioEnded}
        />
      ) : narrationMethod === 'gtts' ? (
        <GTTSNarrationSection
          narrationMethod={narrationMethod}
          isGTTSAvailable={isGTTSAvailable}
          subtitleSource={subtitleSource}
          setSubtitleSource={setSubtitleSource}
          isGenerating={isGenerating}
          translatedSubtitles={translatedSubtitles}
          originalSubtitles={originalSubtitles}
          subtitles={subtitles}
          originalLanguage={originalLanguage}
          translatedLanguage={translatedLanguage}
          setOriginalLanguage={setOriginalLanguage}
          setTranslatedLanguage={setTranslatedLanguage}
          useGroupedSubtitles={useGroupedSubtitles}
          setUseGroupedSubtitles={setUseGroupedSubtitles}
          isGroupingSubtitles={isGroupingSubtitles}
          setIsGroupingSubtitles={setIsGroupingSubtitles}
          groupedSubtitles={groupedSubtitles}
          setGroupedSubtitles={setGroupedSubtitles}
          groupingIntensity={groupingIntensity}
          setGroupingIntensity={setGroupingIntensity}
          gttsLanguage={gttsLanguage}
          setGttsLanguage={setGttsLanguage}
          gttsTld={gttsTld}
          setGttsTld={setGttsTld}
          gttsSlow={gttsSlow}
          setGttsSlow={setGttsSlow}
          handleGTTSNarration={handleGTTSNarration}
          generationResults={generationResults}
          downloadAllAudio={downloadAllAudio}
          downloadAlignedAudio={downloadAlignedAudio}
          cancelGTTSGeneration={cancelGTTSGeneration}
          retryGTTSNarration={retryGTTSNarration}
          retryingSubtitleId={retryingSubtitleId}
          retryFailedGTTSNarrations={retryFailedGTTSNarrations}
          generateAllPendingGTTSNarrations={generateAllPendingGTTSNarrations}
          error={error}
          playAudio={playAudio}
          currentAudio={currentAudio}
          isPlaying={isPlaying}
          audioRef={audioRef}
          handleAudioEnded={handleAudioEnded}
        />
      ) : narrationMethod === 'gemini' ? (
        <GeminiNarrationSection
          subtitleSource={subtitleSource}
          setSubtitleSource={setSubtitleSource}
          isGenerating={isGenerating}
          translatedSubtitles={translatedSubtitles}
          originalSubtitles={originalSubtitles}
          subtitles={subtitles}
          originalLanguage={originalLanguage}
          translatedLanguage={translatedLanguage}
          setOriginalLanguage={setOriginalLanguage}
          setTranslatedLanguage={setTranslatedLanguage}
          useGroupedSubtitles={useGroupedSubtitles}
          setUseGroupedSubtitles={setUseGroupedSubtitles}
          isGroupingSubtitles={isGroupingSubtitles}
          setIsGroupingSubtitles={setIsGroupingSubtitles}
          groupedSubtitles={groupedSubtitles}
          setGroupedSubtitles={setGroupedSubtitles}
          groupingIntensity={groupingIntensity}
          setGroupingIntensity={setGroupingIntensity}
          selectedVoice={selectedVoice}
          setSelectedVoice={setSelectedVoice}
          concurrentClients={concurrentClients}
          setConcurrentClients={setConcurrentClients}
          handleGeminiNarration={handleGeminiNarration}
          generationResults={generationResults}
          downloadAllAudio={downloadAllAudio}
          downloadAlignedAudio={downloadAlignedAudio}
          cancelGeminiGeneration={cancelGeminiGeneration}
          isGeminiAvailable={isGeminiAvailable}
          geminiUnavailableMessage={geminiUnavailableMessage}
          retryGeminiNarration={retryGeminiNarration}
          retryingSubtitleId={retryingSubtitleId}
          retryFailedGeminiNarrations={retryFailedGeminiNarrations}
          generateAllPendingGeminiNarrations={generateAllPendingGeminiNarrations}
          error={error}
        />
      ) : null}
      </div>
    </div>
  );
};

export default UnifiedNarrationSection;
