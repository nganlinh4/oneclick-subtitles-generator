const RIFF_HEADER_BYTES = 44;

/**
 * Records the exact PCM16LE frames delivered by the native live-music transport.
 * Chromium's MediaRecorder leaves streaming WebM duration unset in this WebView; the provider
 * already gives us bounded PCM, so a finite lossless WAV is the native stream's honest container.
 */
export class PcmRecording {
  /** @param {{ sampleRate: number, channels: number, maxBytes: number }} options */
  constructor({ sampleRate, channels, maxBytes }) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) {
      throw new RangeError('sampleRate is outside the supported audio range');
    }
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 8) {
      throw new RangeError('channels is outside the supported audio range');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < channels * 2 || maxBytes > 0xffff_ffff - 36) {
      throw new RangeError('maxBytes is outside the WAV container range');
    }
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.maxBytes = maxBytes;
    /** @type {Uint8Array[]} */
    this.chunks = [];
    this.byteLength = 0;
  }

  /** @param {ArrayBuffer} pcm */
  append(pcm) {
    const frameBytes = this.channels * 2;
    if (!(pcm instanceof ArrayBuffer) || pcm.byteLength === 0 || pcm.byteLength % frameBytes !== 0) {
      throw new TypeError('PCM must contain whole non-empty frames');
    }
    if (this.byteLength > this.maxBytes - pcm.byteLength) {
      throw new RangeError('The live music recording reached its safe size limit');
    }
    this.chunks.push(new Uint8Array(pcm.slice(0)));
    this.byteLength += pcm.byteLength;
  }

  finish() {
    if (this.byteLength === 0) throw new Error('The live music recording contains no audio');
    const bytes = new Uint8Array(RIFF_HEADER_BYTES + this.byteLength);
    const view = new DataView(bytes.buffer);
    writeAscii(bytes, 0, 'RIFF');
    view.setUint32(4, 36 + this.byteLength, true);
    writeAscii(bytes, 8, 'WAVE');
    writeAscii(bytes, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.channels, true);
    view.setUint32(24, this.sampleRate, true);
    const blockAlign = this.channels * 2;
    view.setUint32(28, this.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeAscii(bytes, 36, 'data');
    view.setUint32(40, this.byteLength, true);
    let offset = RIFF_HEADER_BYTES;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

/** @param {Uint8Array} target @param {number} offset @param {string} value */
function writeAscii(target, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}
