import SubtitleSourceSelection from '../components/SubtitleSourceSelection';
import GTTSControls from '../components/GTTSControls';
import GenerateButton from '../components/GenerateButton';
import NarrationResults from '../components/NarrationResults';

const getAudioUrl = () => null;

/**
 * gTTS narration UI branch. Pure, props-driven component.
 * @param {Object} props - Props forwarded from UnifiedNarrationSection
 * @returns {JSX.Element} - Rendered gTTS narration UI
 */
const GTTSNarrationSection = ({
  narrationMethod,
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
  // gTTS controls
  gttsLanguage,
  setGttsLanguage,
  gttsTld,
  setGttsTld,
  gttsSlow,
  setGttsSlow,
  // Generate
  handleGTTSNarration,
  generationResults,
  downloadAllAudio,
  downloadAlignedAudio,
  cancelGTTSGeneration,
  // Results
  retryGTTSNarration,
  retryingSubtitleId,
  retryFailedGTTSNarrations,
  generateAllPendingGTTSNarrations,
  error,
  // Playback
  playAudio,
  currentAudio,
  isPlaying,
  audioRef,
  handleAudioEnded
}) => {
  return (
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
  );
};

export default GTTSNarrationSection;
