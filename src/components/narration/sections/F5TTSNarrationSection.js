import AudioControls from '../components/AudioControls';
import ReferenceAudioSection from '../components/ReferenceAudioSection';
import SubtitleSourceSelection from '../components/SubtitleSourceSelection';
import AdvancedSettingsToggle from '../components/AdvancedSettingsToggle';
import GenerateButton from '../components/GenerateButton';
import NarrationResults from '../components/NarrationResults';
import { getF5TtsLanguageSupport } from '../../../platform/nativeNarrationCapabilities';

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
  setIsGroupingSubtitles,
  groupedSubtitles,
  setGroupedSubtitles,
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
  const selectedLanguage = subtitleSource === 'translated'
    ? translatedLanguage
    : originalLanguage;
  const languageSupport = getF5TtsLanguageSupport(selectedLanguage);
  const languageBlockedReason = languageSupport.supported
    ? ''
    : languageSupport.reason === 'unknown'
      ? t(
        'narration.f5LanguageRequiredError',
        'Detect or select the subtitle language before using F5-TTS.'
      )
      : t(
        'narration.f5UnsupportedLanguageError',
        'F5-TTS supports English and Chinese subtitles only. Choose another narration engine for this language.'
      );
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
        setIsGroupingSubtitles={setIsGroupingSubtitles}
        groupedSubtitles={groupedSubtitles}
        onGroupedSubtitlesGenerated={setGroupedSubtitles}
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
        serviceUnavailableMessage={t('narration.engineUnavailableMessage', 'This narration engine could not be prepared automatically. Try generating again.')}
        narrationMethod="f5tts"
        generationBlockedReason={languageBlockedReason}
      />

      {/* Results */}
      <NarrationResults
        generationResults={generationResults}
        playAudio={playAudio}
        currentAudio={currentAudio}
        isPlaying={isPlaying}
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
        isServiceAvailable={isAvailable}
        referenceAudio={referenceAudio}
        narrationMethod="f5tts"
        generationBlockedReason={languageBlockedReason}
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
