// Public entry point for native media: descriptor validation, the editor's media session,
// recorder audio blobs and downloaded-candidate lifecycle. Each concern lives in its own module.
export {
  createNativeMediaDescriptor,
  isNativeMediaDescriptor,
  isNativeMediaPlaybackUrl,
} from './mediaDescriptors';
export {
  claimMediaDrop,
  clearMedia,
  getSelectedMedia,
  openMediaAsset,
  restoreMediaAsset,
  selectMedia,
} from './mediaSessionCommands';
export { importAudioBlob, releaseAudioBlob } from './mediaAudioBlob';
export { claimMediaCandidate, discardMediaCandidate } from './mediaCandidateLifecycle';
