/**
 * Utility functions for video processing and subtitle rendering
 */
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { isNativeMediaDescriptor } from '../platform/mediaService';

/**
 * Check if there's a valid downloaded video file
 * This function handles the case where blob URLs become invalid after page refresh
 * @param {File} uploadedFile - The uploaded file object (optional)
 * @returns {boolean} True if there's a valid downloaded video
 */
export const hasValidDownloadedVideo = (uploadedFile = null) => {
  if (isDesktopRuntime()) return isNativeMediaDescriptor(uploadedFile);
  return typeof File !== 'undefined' && uploadedFile instanceof File;
};

/**
 * Clean up invalid blob URLs from localStorage
 * This should be called on page load to clean up stale blob URLs
 */
export const cleanupInvalidBlobUrls = () => {
  try {
    // Compatibility cleanup only: persisted blob URLs are never read as media authority.
    localStorage.removeItem('current_file_url');
  } catch {
    // Storage may be unavailable in a sandboxed browser preview.
  }
};
