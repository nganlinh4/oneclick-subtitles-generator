/**
 * Utility functions for audio conversion
 */

/**
 * Convert base64 string to ArrayBuffer
 * @param {string} base64 - Base64 encoded string
 * @returns {ArrayBuffer} - Decoded ArrayBuffer
 */
export const base64ToArrayBuffer = (base64) => {
  try {
    // Remove any whitespace or line breaks that might be in the base64 string
    const cleanBase64 = base64.replace(/\s/g, '');

    // Decode the Base64 string to a binary string
    const binaryString = atob(cleanBase64);


    // Convert the binary string to a Uint8Array
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;
  } catch (error) {
    console.error('Error decoding Base64 data:', error);
    throw new Error(`Failed to decode Base64 data: ${error.message}`);
  }
};

/**
 * Convert PCM data to Float32Array for better audio processing
 * @param {ArrayBuffer} pcmData - PCM audio data
 * @param {number} bitsPerSample - Bits per sample (default: 16)
 * @returns {Float32Array} - Converted Float32Array
 */
export const pcmToFloat32 = (pcmData, _bitsPerSample = 16) => {
  try {


    // For 16-bit PCM, we need to convert each pair of bytes to a float
    const pcmView = new DataView(pcmData);
    const floatArray = new Float32Array(pcmData.byteLength / 2);

    // Log a sample of the PCM data for debugging
    const sampleValues = [];
    for (let i = 0; i < Math.min(10, floatArray.length); i++) {
      const int16 = pcmView.getInt16(i * 2, true);
      sampleValues.push(int16);
    }


    // Convert all samples to float
    for (let i = 0; i < floatArray.length; i++) {
      // Get 16-bit sample (signed)
      const int16 = pcmView.getInt16(i * 2, true);
      // Convert to float in range [-1, 1]
      floatArray[i] = int16 / 32768.0;
    }


    return floatArray;
  } catch (error) {
    console.error('Error converting PCM to Float32Array:', error);
    throw new Error(`Failed to convert PCM data: ${error.message}`);
  }
};
