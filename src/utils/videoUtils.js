/**
 * Utility functions for video processing and subtitle rendering
 */
import { isNativeMediaDescriptor } from '../platform/mediaService';

/**
 * Check if there's a valid downloaded video file
 * This function handles the case where blob URLs become invalid after page refresh
 * @param {File} uploadedFile - The uploaded file object (optional)
 * @returns {boolean} True if there's a valid downloaded video
 */
export const hasValidDownloadedVideo = (uploadedFile = null) => (
  isNativeMediaDescriptor(uploadedFile)
);

