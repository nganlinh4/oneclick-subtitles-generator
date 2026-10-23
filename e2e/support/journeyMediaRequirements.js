import { basename } from 'node:path';

export const JOURNEY_MEDIA_REQUIREMENT = Object.freeze({
  generic: 'generic-real-media',
  custom: 'custom-staged-media',
  none: 'none',
});

// Explicit because `openProjectWithMedia()` describes the customer action, not the fixture source:
// long-media and four-window ASR use that same action with deliberately different staged inputs.
const GENERIC_REAL_MEDIA = new Set([
  'bulkTranslationFileIO.journey.js',
  'cacheClearSafety.journey.js',
  'canvasPlaybackPerformance.journey.js',
  'edgeTtsNarrationGeneration.journey.js',
  'editorCueCrudAndHistory.journey.js',
  'editPersistRelaunch.journey.js',
  'historyAcrossRestart.journey.js',
  'exportAnimationParityMatrix.journey.js',
  'frontendResponsiveness.journey.js',
  'geminiNarrationGeneration.journey.js',
  'geminiDocumentSuccess.journey.js',
  'geminiOutputPreview.journey.js',
  'geminiTranscriptionSuccess.journey.js',
  'geminiVideoAnalysisSuccess.journey.js',
  'localAsrGeneration.journey.js',
  'localFileImport.journey.js',
  'mainPreviewControlsAndFullscreen.journey.js',
  'mainPreviewRenderHandoff.journey.js',
  'presentationAudit.journey.js',
  'manualLyricsAndGeniusBoundary.journey.js',
  'narrationGeneration.journey.js',
  'nativeExportDecoded.journey.js',
  'providerBoundaries.journey.js',
  'referenceVoiceAndPerCueNarration.journey.js',
  'renderAudioNarrationMix.journey.js',
  'renderCancelRetryExport.journey.js',
  'renderFormatTransformMatrix.journey.js',
  'renderInterruptRecovery.journey.js',
  'settingsSurface.journey.js',
  'settingsVideoProcessingAndPrompts.journey.js',
  'srtOnlyMediaAttach.journey.js',
  'subtitleCustomizationPreview.journey.js',
  'subtitleMaterialAndAnimation.journey.js',
  'timelineAdvancedEditing.journey.js',
  'transcriptionRulesAndAnalysis.journey.js',
  'translationPersistence.journey.js',
  'unicodeCues.journey.js',
  'wordNativeFreshVideoSpeech.journey.js',
]);

const CUSTOM_STAGED_MEDIA = new Set([
  'geminiBackgroundImageSuccess.journey.js',
  'geminiMediaBenchmark.journey.js',
  'geminiMultiWindowTranscription.journey.js',
  'geminiTranslationSuccess.journey.js',
  'longMediaOperationRecovery.journey.js',
  'longMediaResourceBounds.journey.js',
  'multiWindowAsrPersistence.journey.js',
]);

const NO_STAGED_MEDIA = new Set([
  'readmeScreenshots.journey.js',
  'largeSubtitleResponsiveness.journey.js',
  'aboutAndUpdaterLifecycle.journey.js',
  'alternateProviderDownload.journey.js',
  'authenticatedCookieDownload.journey.js',
  'browserProfileCookieDownload.journey.js',
  'damagedFontPayload.journey.js',
  'downloadCancellationRetryIdentity.journey.js',
  'downloadQualityCancellationIdentity.journey.js',
  'downloadQualityVariants.journey.js',
  'engineCatalogMatrix.journey.js',
  'failedDownloadNoStale.journey.js',
  'geminiLiveMusicSuccess.journey.js',
  'nativeToolsInstall.journey.js',
  'playlistWatchSelection.journey.js',
  'promptDjMidiInput.journey.js',
  'settingsAppearancePersistence.journey.js',
  'settingsCredentialLifecycle.journey.js',
  'settingsDraftIsolation.journey.js',
  'settingsNarrationModelManagement.journey.js',
  'settingsToolsRemoveAndFactoryReset.journey.js',
  'startup.journey.js',
  'subtitleDocumentRoundTrip.journey.js',
  'urlLocalAsrPreview.journey.js',
  'urlToPreview.journey.js',
  'youtubeSearchAndHistory.journey.js',
]);

export const journeyMediaRequirement = (spec) => {
  const name = basename(spec);
  if (GENERIC_REAL_MEDIA.has(name)) return JOURNEY_MEDIA_REQUIREMENT.generic;
  if (CUSTOM_STAGED_MEDIA.has(name)) return JOURNEY_MEDIA_REQUIREMENT.custom;
  if (NO_STAGED_MEDIA.has(name)) return JOURNEY_MEDIA_REQUIREMENT.none;
  throw new Error(`journey has no explicit staged-media classification: ${name}`);
};

export const classifiedMediaJourneys = () => Object.freeze({
  generic: Object.freeze([...GENERIC_REAL_MEDIA].sort()),
  custom: Object.freeze([...CUSTOM_STAGED_MEDIA].sort()),
  none: Object.freeze([...NO_STAGED_MEDIA].sort()),
});
