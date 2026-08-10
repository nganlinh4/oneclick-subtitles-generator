
/**
 * Static <style> block for the video preview: spinner keyframes, hiding the
 * native media controls across browsers, and the fullscreen container/video
 * sizing rules. Extracted verbatim from VideoPreview's render so the parent
 * stays focused on behaviour. No props — purely presentational.
 */
const VideoPlayerStyles = () => (
  <style>
    {`
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      /* Force hide native video controls in all states including fullscreen */
      .video-player::-webkit-media-controls {
        display: none !important;
      }
      .video-player::-webkit-media-controls-panel {
        display: none !important;
      }
      .video-player::-webkit-media-controls-play-button {
        display: none !important;
      }
      .video-player::-webkit-media-controls-timeline {
        display: none !important;
      }
      .video-player::-webkit-media-controls-current-time-display {
        display: none !important;
      }
      .video-player::-webkit-media-controls-time-remaining-display {
        display: none !important;
      }
      .video-player::-webkit-media-controls-mute-button {
        display: none !important;
      }
      .video-player::-webkit-media-controls-volume-slider {
        display: none !important;
      }
      .video-player::-webkit-media-controls-fullscreen-button {
        display: none !important;
      }
      .video-player::-webkit-media-controls-overlay-play-button {
        display: none !important;
      }

      /* Firefox */
      .video-player::-moz-media-controls {
        display: none !important;
      }

      /* Edge/IE */
      .video-player::-ms-media-controls {
        display: none !important;
      }

      /* Additional fallback */
      .video-player {
        outline: none !important;
      }
      .video-player:focus {
        outline: none !important;
      }

      /* Fullscreen container styling - remove centering */
      .native-video-container:fullscreen {
        width: 100vw !important;
        height: 100vh !important;
        background: black !important;
        position: relative !important;
        display: block !important;
        padding: 0 !important;
        margin: 0 !important;
      }

      .native-video-container:-webkit-full-screen {
        width: 100vw !important;
        height: 100vh !important;
        background: black !important;
        position: relative !important;
        display: block !important;
        padding: 0 !important;
        margin: 0 !important;
      }

      .native-video-container:-moz-full-screen {
        width: 100vw !important;
        height: 100vh !important;
        background: black !important;
        position: relative !important;
        display: block !important;
        padding: 0 !important;
        margin: 0 !important;
      }

      .native-video-container:-ms-fullscreen {
        width: 100vw !important;
        height: 100vh !important;
        background: black !important;
        position: relative !important;
        display: block !important;
        padding: 0 !important;
        margin: 0 !important;
      }

      /* Video in fullscreen - use transform scale approach */
      .native-video-container:fullscreen .video-player,
      .native-video-container:-webkit-full-screen .video-player,
      .native-video-container:-moz-full-screen .video-player,
      .native-video-container:-ms-fullscreen .video-player {
        width: 100vw !important;
        height: 100vh !important;
        max-width: none !important;
        max-height: none !important;
        min-width: 100vw !important;
        min-height: 100vh !important;
        object-fit: contain !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        z-index: 1000 !important;
        transform: none !important;
      }

      /* Video wrapper in fullscreen */
      .native-video-container:fullscreen .video-wrapper,
      .native-video-container:-webkit-full-screen .video-wrapper,
      .native-video-container:-moz-full-screen .video-wrapper,
      .native-video-container:-ms-fullscreen .video-wrapper {
        width: 100vw !important;
        height: 100vh !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        z-index: 1 !important;
      }

      /* Force video element to fill in fullscreen - multiple selectors for maximum coverage */
      .native-video-container:fullscreen video,
      .native-video-container:-webkit-full-screen video,
      .native-video-container:-moz-full-screen video,
      .native-video-container:-ms-fullscreen video,
      .native-video-container:fullscreen .video-player,
      .native-video-container:-webkit-full-screen .video-player,
      .native-video-container:-moz-full-screen .video-player,
      .native-video-container:-ms-fullscreen .video-player {
        width: 100vw !important;
        height: 100vh !important;
        object-fit: contain !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        z-index: 1000 !important;
        transform: none !important;
        max-width: none !important;
        max-height: none !important;
        min-width: 100vw !important;
        min-height: 100vh !important;
        cursor: pointer !important;
        touch-action: manipulation !important;
      }
    `}
  </style>
);

export default VideoPlayerStyles;
