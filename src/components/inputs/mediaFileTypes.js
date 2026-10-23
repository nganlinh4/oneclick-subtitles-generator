// Size limit and audio/video recognition for files picked or dropped into the upload input.

// Maximum file size in MB (5GB = 5120MB)
export const MAX_FILE_SIZE_MB = 5120;

const SUPPORTED_AUDIO_EXTENSIONS = [
  ".wav", ".mp3", ".aiff", ".aac", ".ogg", ".flac", ".m4a", ".wma", ".opus",
  ".amr", ".au", ".caf", ".dts", ".ac3", ".ape", ".mka", ".ra", ".webm"
];

const SUPPORTED_VIDEO_EXTENSIONS = [
  ".mp4", ".mpeg", ".mpg", ".mov", ".avi", ".flv", ".webm", ".wmv", ".3gp", ".3gpp", ".mkv"
];

const extensionOf = (fileName) => fileName.toLowerCase().substring(fileName.lastIndexOf('.'));

// A video MIME type, or a known video extension when the MIME type is missing or generic.
export const isVideoFile = (mimeType, fileName = '') => (
  mimeType.startsWith('video/') || SUPPORTED_VIDEO_EXTENSIONS.includes(extensionOf(fileName))
);

// Any audio MIME type, or a known audio extension when the MIME type is missing or generic.
export const isAudioFile = (mimeType, fileName = '') => (
  mimeType.startsWith('audio/') || SUPPORTED_AUDIO_EXTENSIONS.includes(extensionOf(fileName))
);
