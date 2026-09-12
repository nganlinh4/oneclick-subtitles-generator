import GeminiSubtitleSourceSelection from '../components/GeminiSubtitleSourceSelection';
import GeminiVoiceSelection from '../components/GeminiVoiceSelection';
import GeminiConcurrentClientsSlider from '../components/GeminiConcurrentClientsSlider';
import GenerateButton from '../components/GenerateButton';
import GeminiNarrationResults from '../components/GeminiNarrationResults';

/**
 * Gemini narration UI branch. Pure, props-driven component.
 * @param {Object} props - Props forwarded from UnifiedNarrationSection
 * @returns {JSX.Element} - Rendered Gemini narration UI
 */
const GeminiNarrationSection = ({
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
  // Voice / concurrency
  selectedVoice,
  setSelectedVoice,
  concurrentClients,
  setConcurrentClients,
  // Generate
  handleGeminiNarration,
  generationResults,
  downloadAllAudio,
  downloadAlignedAudio,
  cancelGeminiGeneration,
  isGeminiAvailable,
  geminiUnavailableMessage,
  // Results
  retryGeminiNarration,
  retryingSubtitleId,
  retryFailedGeminiNarrations,
  generateAllPendingGeminiNarrations,
  error
}) => {
  return (
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
        setIsGroupingSubtitles={setIsGroupingSubtitles}
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
        narrationMethod="gemini"
        handleGenerateNarration={handleGeminiNarration}
        isGenerating={isGenerating}
        referenceAudio={null}
        subtitleSource={subtitleSource}
        cancelGeneration={cancelGeminiGeneration}
        downloadAllAudio={downloadAllAudio}
        downloadAlignedAudio={downloadAlignedAudio}
        generationResults={generationResults}
        isServiceAvailable={isGeminiAvailable}
        serviceUnavailableMessage={geminiUnavailableMessage}
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
        isServiceAvailable={isGeminiAvailable}
        serviceUnavailableMessage={geminiUnavailableMessage}
      />

      {/* No need for a separate audio element here as it's included in the GeminiNarrationResults component */}
    </div>
  );
};

export default GeminiNarrationSection;
