/**
 * Captures the current frame of the preview video to a canvas, converts it to
 * a PNG blob, and triggers a download.
 *
 * Uses DOM selectors directly, so it carries no component-state closure.
 */
export const extractFrame = async () => {
  try {
    const videoElement = document.querySelector(
      ".native-video-container video",
    );
    if (!videoElement) {
      console.error("Video element not found");
      return;
    }

    // Create canvas to capture current frame
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // Set canvas dimensions to match video
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;

    // Draw current video frame to canvas
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

    // Convert canvas to blob
    canvas.toBlob(async (blob) => {
      if (blob) {
        try {
          // Generate filename with timestamp
          const currentTime = Math.floor(videoElement.currentTime);
          const minutes = Math.floor(currentTime / 60);
          const seconds = currentTime % 60;
          const timestamp = `${minutes}m${seconds}s`;

          await exportGeneratedBlob(blob, `frame_${timestamp}.png`);
          console.log("Frame extracted successfully");
        } catch (error) {
          console.error("Error exporting frame:", error);
          showErrorToast(error?.message || "The frame could not be saved.", 8000);
        }
      } else {
        console.error("Failed to create blob from canvas");
      }
    }, "image/png");
  } catch (error) {
    console.error("Error extracting frame:", error);
    showErrorToast(error?.message || "The frame could not be saved.", 8000);
  }
};
import { exportGeneratedBlob } from "../../platform/generatedFileExportService";
import { showErrorToast } from "../../utils/toastUtils";
