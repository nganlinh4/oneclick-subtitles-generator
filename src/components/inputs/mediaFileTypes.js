// Video recognition for the media shown in the upload input.

const SUPPORTED_VIDEO_EXTENSIONS = [
  ".mp4", ".mpeg", ".mpg", ".mov", ".avi", ".flv", ".webm", ".wmv", ".3gp", ".3gpp", ".mkv"
];

const extensionOf = (fileName) => fileName.toLowerCase().substring(fileName.lastIndexOf('.'));

// A video MIME type, or a known video extension when the MIME type is missing or generic.
export const isVideoFile = (mimeType, fileName = '') => (
  mimeType.startsWith('video/') || SUPPORTED_VIDEO_EXTENSIONS.includes(extensionOf(fileName))
);
