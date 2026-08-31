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
  'exportAnimationParityMatrix.journey.js',
  'geminiCredentialBoundary.journey.js',
  'geminiDocumentSuccess.journey.js',
  'geminiOutputPreview.journey.js',
  'geminiTranscriptionSuccess.journey.js',
  'geminiTranslationSuccess.journey.js',
  'geminiVideoAnalysisSuccess.journey.js',
  'localAsrGeneration.journey.js',
  'localFileImport.journey.js',
  'mainPreviewControlsAndFullscreen.journey.js',
  'mainPreviewRenderHandoff.journey.js',
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
  'timelineBoundary.journey.js',
  'transcriptionRulesAndAnalysis.journey.js',
  'translatedDocumentExports.journey.js',
  'translationPersistence.journey.js',
  'unicodeCues.journey.js',
]);

const CUSTOM_STAGED_MEDIA = new Set([
  'geminiBackgroundImageSuccess.journey.js',
  'geminiMultiWindowTranscription.journey.js',
  'longMediaOperationRecovery.journey.js',
  'longMediaResourceBounds.journey.js',
  'multiWindowAsrPersistence.journey.js',
]);

const NO_STAGED_MEDIA = new Set([
  'aboutAndUpdaterLifecycle.journey.js',
  'alternateLocalAsrMatrix.journey.js',
  'damagedFontPayload.journey.js',
  'defaultFont.journey.js',
  'downloadCancellationRetryIdentity.journey.js',
  'downloadQualityVariants.journey.js',
  'failedDownloadNoStale.journey.js',
  'freshInstallVisual.journey.js',
  'geminiLiveMusicSuccess.journey.js',
  'narrationEngineMatrix.journey.js',
  'nativeToolsInstall.journey.js',
  'reconnaissance.journey.js',
  'settingsAppearancePersistence.journey.js',
  'settingsCredentialLifecycle.journey.js',
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
