/**
 * Legacy media-alias resolution retained only for narration-result migration. Reference audio is
 * stored by native project ID and never written to browser storage.
 */

/**
 * Resolve the current media id from localStorage (YouTube video id or cached file id).
 * @returns {string|null}
 */
export const getCurrentMediaId = () => {
  const currentVideoUrl = localStorage.getItem('current_video_url');
  const currentFileUrl = localStorage.getItem('current_file_url');

  if (currentVideoUrl) {
    const match = currentVideoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  } else if (currentFileUrl) {
    return localStorage.getItem('current_file_cache_id');
  }
  return null;
};
