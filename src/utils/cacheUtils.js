/**
 * Utilities for handling caching of subtitles
 */

/**
 * Generate a cache ID for a file by creating a hash of its content
 * @param {File} file - The file to hash
 * @returns {Promise<string>} - A promise that resolves to the cache ID
 */
export const generateFileCacheId = async (file) => {
  // Check if file is undefined or null
  if (!file) {
    console.error('Error generating file cache ID: File is undefined or null');
    return `fallback_cache_id_${Date.now()}`;
  }

  try {
    // Check if file has required properties
    if (!file.size || !file.name) {
      console.warn('File is missing required properties (size or name), using fallback ID');
      return `incomplete_file_${Date.now()}`;
    }

    // For files, generate a hash based on the first 1MB of content + filename + size
    // This is a good balance between uniqueness and performance
    const maxBytes = 1024 * 1024; // 1MB
    const bytes = await readFileChunk(file, 0, Math.min(maxBytes, file.size));

    // Combine with filename and size for better uniqueness
    const fileInfo = `${file.name}_${file.size}_${file.type || 'unknown'}`;
    const dataToHash = bytes + fileInfo;

    // Generate hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataToHash));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex;
  } catch (error) {
    console.error('Error generating file cache ID:', error);
    // Fallback to a less reliable but still useful ID
    try {
      return `${(file.name || 'unknown').replace(/[^a-z0-9]/gi, '')}_${file.size || 0}_${Date.now()}`;
    } catch (fallbackError) {
      console.error('Error generating fallback cache ID:', fallbackError);
      return `emergency_fallback_${Date.now()}`;
    }
  }
};

/**
 * Read a chunk of a file as text
 * @param {File} file - The file to read
 * @param {number} start - The start byte position
 * @param {number} end - The end byte position
 * @returns {Promise<string>} - A promise that resolves to the chunk as text
 */
const readFileChunk = (file, start, end) => {
  return new Promise((resolve) => {
    if (!file) {
      console.error('Cannot read chunk: file is undefined');
      return resolve(''); // Return empty string instead of failing
    }

    try {
      const reader = new FileReader();

      reader.onload = () => {
        try {
          resolve(reader.result || '');
        } catch (error) {
          console.error('Error in FileReader onload:', error);
          resolve(''); // Return empty string on error
        }
      };

      reader.onerror = (error) => {
        console.error('FileReader error:', error);
        resolve(''); // Return empty string on error
      };

      // Make sure we can slice the file
      if (typeof file.slice !== 'function') {
        console.error('File does not support slice method');
        return resolve('');
      }

      const slice = file.slice(start, end);
      reader.readAsText(slice);
    } catch (error) {
      console.error('Error in readFileChunk:', error);
      resolve(''); // Return empty string on error
    }
  });
};
