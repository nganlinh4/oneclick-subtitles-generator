import SubtitleSourceSelection from '../components/SubtitleSourceSelection';
import EdgeTTSControls from '../components/EdgeTTSControls';
import GenerateButton from '../components/GenerateButton';
import NarrationResults from '../components/NarrationResults';

const getAudioUrl = () => null;

/**
 * Edge TTS narration UI branch. Pure, props-driven component.
 * @param {Object} props - Props forwarded from UnifiedNarrationSection
 * @returns {JSX.Element} - Rendered Edge TTS narration UI
 */
const EdgeTTSNarrationSection = ({
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
  // Edge TTS controls
  edgeTTSVoice,
  setEdgeTTSVoice,
  edgeTTSRate,
  setEdgeTTSRate,
  edgeTTSVolume,
  setEdgeTTSVolume,
  edgeTTSPitch,
  setEdgeTTSPitch,
  // Generate
  handleEdgeTTSNarration,
  generationResults,
  downloadAllAudio,
  downloadAlignedAudio,
  cancelEdgeTTSGeneration,
  // Results
  retryEdgeTTSNarration,
  retryingSubtitleId,
  retryFailedEdgeTTSNarrations,
  generateAllPendingEdgeTTSNarrations,
  error,
  // Playback
  playAudio,
  currentAudio,
  isPlaying,
  audioRef,
  handleAudioEnded
}) => {
  return (
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
  );
};

export default EdgeTTSNarrationSection;
