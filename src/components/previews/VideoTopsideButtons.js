import { useTranslation } from "react-i18next";
import LiquidGlass from "../common/LiquidGlass";
import { extractAndDownloadAudio } from "../../utils/fileUtils";
import VideoControlButton, {
  getVideoControlVisibilityStyle,
} from "./VideoControlButton";
import { narrationRefreshHandler } from "./narrationRefreshHandler";
import { extractFrame } from "./FrameExtractionHandler";

const VideoTopsideButtons = ({
  showCustomControls,
  isFullscreen,
  controlsVisible,
  isVideoHovered,
  isRefreshingNarration,
  setIsRefreshingNarration,
  isAudioDownloading,
  setIsAudioDownloading,
  setError: _setError,
  videoRef,
  videoSource,
  fileType,
  useOptimizedPreview,
  optimizedVideoUrl,
  videoUrl,
}) => {
  const { t } = useTranslation();

  // Check if the current file is audio
  const isAudioFile = fileType && fileType.startsWith("audio/");

  // Shared visibility style for all top-side control buttons
  const visibilityStyle = getVideoControlVisibilityStyle({
    isFullscreen,
    controlsVisible,
    isVideoHovered,
  });

  return (
    <>
      {/* Top buttons container */}
      <div
        style={{
          position: "absolute",
          top: "10px",
          left: "10px",
          right: "10px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          zIndex: 10,
          pointerEvents: "none", // Allow clicks to pass through the container
        }}
      >
        {/* Left side buttons */}
        <div
          style={{
            display: "flex",
            gap: "10px",
            alignItems: "center",
          }}
        >
          {/* Refresh Narration button - only show when custom controls are available */}
          {showCustomControls && (
            <VideoControlButton
              isLoading={isRefreshingNarration}
              icon="refresh"
              iconSize={22}
              spinnerSize={22}
              spinnerClassName="narration-refresh-loading"
              label={t("preview.refreshNarration", "Refresh Narration")}
              loadingLabel={t("preview.refreshingNarration", "Refreshing...")}
              ariaLabel={t("preview.refreshNarration", "Refresh Narration")}
              themeClassName="theme-primary"
              visibilityStyle={visibilityStyle}
              disabled={isRefreshingNarration}
              contentStyleExtras={{
                opacity: isRefreshingNarration ? 0.7 : 1,
                cursor: isRefreshingNarration ? "not-allowed" : "pointer",
              }}
              onClick={() =>
                narrationRefreshHandler({
                  videoRef,
                  setIsRefreshingNarration,
                  t,
                })
              }
            />
          )}

          {/* Gemini FPS Info button - only show when custom controls are available and optimization is enabled */}
          {showCustomControls &&
            localStorage.getItem("optimize_videos") === "true" && (
              <LiquidGlass
                width="auto"
                height={50}
                position="relative"
                borderRadius="25px"
                className="content-center interactive theme-warning shape-circle video-control"
                cursor="pointer"
                effectIntensity={0.7}
                effectRadius={0.6}
                effectWidth={0.4}
                effectHeight={0.4}
                animateOnHover={true}
                hoverScale={1.1}
                updateOnMouseMove={true}
                aria-label="Gemini FPS Info"
                style={visibilityStyle}
                onClick={() => {
                  window.open(
                    "https://ai.google.dev/gemini-api/docs/video-understanding",
                    "_blank",
                  );
                }}
              >
                <div
                  title={t('preview.geminiFpsTooltip', 'Gemini only processes video at 1 FPS even if you send a higher-FPS video — click the button for more. Choose Render Video for the best quality + FPS.')}
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    padding: "0 12px",
                    minWidth: "fit-content",
                  }}
                >
                  <span
                    className="material-symbols-rounded"
                    style={{
                      color: "white",
                      fontSize: 24,
                      textShadow: "0 1px 2px rgba(0, 0, 0, 0.8)",
                      display: "inline-block",
                    }}
                  >
                    info
                  </span>
                </div>
              </LiquidGlass>
            )}
        </div>

        {/* Right side buttons */}
        <div
          style={{
            display: "flex",
            gap: "10px",
            alignItems: "center",
          }}
        >
          {/* Extract frame button - only show when custom controls are available and not audio file */}
          {showCustomControls && !isAudioFile && (
            <VideoControlButton
              isLoading={false}
              icon="image"
              iconSize={20}
              label={t("preview.extractFrame", "Extract Frame")}
              ariaLabel={t("preview.extractFrame", "Extract Frame")}
              themeClassName="theme-info"
              visibilityStyle={visibilityStyle}
              contentStyleExtras={{
                minWidth: "fit-content",
                whiteSpace: "nowrap",
              }}
              onClick={extractFrame}
            />
          )}

          {/* Download audio button - only show when custom controls are available and not audio file */}
          {showCustomControls && !isAudioFile && (
            <VideoControlButton
              isLoading={isAudioDownloading}
              icon="download"
              iconSize={20}
              spinnerSize={20}
              spinnerClassName="audio-download-loading"
              contentGap="6px"
              label={t("preview.downloadAudio", "Download Audio")}
              loadingLabel={t("preview.downloadingAudio", "Downloading...")}
              ariaLabel={t("preview.downloadAudio", "Download Audio")}
              themeClassName={
                isAudioDownloading ? "theme-secondary" : "theme-success"
              }
              cursor={isAudioDownloading ? "not-allowed" : "pointer"}
              effectIntensity={isAudioDownloading ? 0.3 : 0.6}
              animateOnHover={!isAudioDownloading}
              visibilityStyle={visibilityStyle}
              contentStyleExtras={{
                opacity: isAudioDownloading ? 0.7 : 1,
                cursor: isAudioDownloading ? "not-allowed" : "pointer",
                minWidth: "fit-content",
                whiteSpace: "nowrap",
              }}
              onClick={async () => {
                if (isAudioDownloading) return; // Prevent multiple clicks

                // Get video title or use default
                const videoTitle = videoSource?.title || "audio";
                // Use the current video URL (optimized or original)
                const currentVideoUrl =
                  useOptimizedPreview && optimizedVideoUrl
                    ? optimizedVideoUrl
                    : videoUrl;

                // Show loading state
                setIsAudioDownloading(true);

                // Extract and download audio - our utility function now handles blob URLs properly
                const success = await extractAndDownloadAudio(
                  currentVideoUrl,
                  videoTitle,
                );

                // Reset loading state
                setIsAudioDownloading(false);

                // Show error if failed
                if (!success) {
                  // Dispatch aligned-narration-status event for auto-dismissing toast
                  window.dispatchEvent(
                    new CustomEvent("aligned-narration-status", {
                      detail: {
                        status: "error",
                        message: t(
                          "preview.audioExtractionError",
                          "Failed to extract audio from video. Please try again.",
                        ),
                        isStillGenerating: false,
                      },
                    }),
                  );
                }
              }}
            />
          )}
        </div>
      </div>
    </>
  );
};

export default VideoTopsideButtons;
