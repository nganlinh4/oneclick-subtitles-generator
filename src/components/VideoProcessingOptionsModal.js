import CreateSubtitlesModal from './CreateSubtitlesModal';

/**
 * Legacy modal wrapper forwarding to the unified task-first CreateSubtitlesModal.
 */
const VideoProcessingOptionsModal = (props) => {
  return <CreateSubtitlesModal {...props} />;
};

export default VideoProcessingOptionsModal;
