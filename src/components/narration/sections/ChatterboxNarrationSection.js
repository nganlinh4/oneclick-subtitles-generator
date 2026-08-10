import AudioControls from '../components/AudioControls';
import SubtitleSourceSelection from '../components/SubtitleSourceSelection';
import ChatterboxControls from '../components/ChatterboxControls';
import GenerateButton from '../components/GenerateButton';
import NarrationResults from '../components/NarrationResults';

const getAudioUrl = () => null;

/**
 * Chatterbox narration UI branch. Pure, props-driven component.
 * @param {Object} props - Props forwarded from UnifiedNarrationSection
 * @returns {JSX.Element} - Rendered Chatterbox narration UI
 */
const ChatterboxNarrationSection = ({
  t,
  narrationMethod,
  // Audio controls / reference audio
  handleFileUpload,
  fileInputRef,
  isRecording,
  isStartingRecording,
  recordingStartTime,
  startRecording,
  stopRecording,
  isChatterboxAvailable,
  referenceAudio,
  clearReferenceAudio,
  handleExampleSelect,
  // Subtitle source selection
  subtitleSource,
  setSubtitleSource,
  isGenerating,
  translatedSubtitles,
  originalSubtitles,
  subtitles,
  originalLanguage,
  translatedLanguage,
  setOriginalLanguage,
  setTranslatedLanguage,
  useGroupedSubtitles,
  setUseGroupedSubtitles,
  isGroupingSubtitles,
  groupedSubtitles,
  setGroupedSubtitles,
  groupingIntensity,
  setGroupingIntensity,
  chatterboxLanguage,
  setChatterboxLanguage,
  // Chatterbox controls
  exaggeration,
  setExaggeration,
  cfgWeight,
  setCfgWeight,
  // Generate
  handleChatterboxNarration,
  generationResults,
  downloadAllAudio,
  downloadAlignedAudio,
  cancelChatterboxGeneration,
  // Results
  playAudio,
  currentAudio,
  isPlaying,
  retryChatterboxNarration,
  retryingSubtitleId,
  retryFailedChatterboxNarrations,
  generateAllPendingChatterboxNarrations,
  error,
  // Audio playback
  audioRef,
  handleAudioEnded
}) => {
  return (
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
  );
};

export default ChatterboxNarrationSection;
