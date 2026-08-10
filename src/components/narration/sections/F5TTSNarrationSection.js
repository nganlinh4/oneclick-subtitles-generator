import AudioControls from '../components/AudioControls';
import ReferenceAudioSection from '../components/ReferenceAudioSection';
import SubtitleSourceSelection from '../components/SubtitleSourceSelection';
import AdvancedSettingsToggle from '../components/AdvancedSettingsToggle';
import GenerateButton from '../components/GenerateButton';
import NarrationResults from '../components/NarrationResults';

const getAudioUrl = () => null;

/**
 * F5-TTS narration UI branch. Pure, props-driven component.
 * @param {Object} props - Props forwarded from UnifiedNarrationSection
 * @returns {JSX.Element} - Rendered F5-TTS narration UI
 */
const F5TTSNarrationSection = ({
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
  isAvailable,
  referenceAudio,
  clearReferenceAudio,
  handleExampleSelect,
  autoRecognize,
  setAutoRecognize,
  isRecognizing,
  referenceText,
  setReferenceTextWithCache,
  isExtractingSegment,
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
  groupingIntensity,
  setGroupingIntensity,
  selectedNarrationModel,
  setSelectedNarrationModel,
  // Advanced settings
  advancedSettings,
  setAdvancedSettings,
  // Generate
  handleGenerateNarration,
  generationResults,
  downloadAllAudio,
  downloadAlignedAudio,
  cancelGeneration,
  // Results
  playAudio,
  currentAudio,
  isPlaying,
  retryF5TTSNarration,
  retryingSubtitleId,
  retryFailedNarrations,
  generateAllPendingF5TTSNarrations,
  // Audio playback
  audioRef,
  handleAudioEnded
}) => {
  return (
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
        serviceUnavailableMessage={t('narration.serviceUnavailableMessage', 'Install or start F5-TTS from Settings > Tools. If it just started, wait about 1 minute for it to become ready.')}
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
  );
};

export default F5TTSNarrationSection;
