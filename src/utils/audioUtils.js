// Utility to extract an audio segment from a media File and return it as base64-encoded WAV (mono, 16kHz)
// Works in browser using Web Audio API and OfflineAudioContext

export async function extractSegmentAsWavBase64(file, startSec, endSec) {
  if (!file) throw new Error('No file provided');
  const start = Math.max(0, Number(startSec) || 0);
  const end = Math.max(start, Number(endSec) || start);

  // Read file to ArrayBuffer
  const arrayBuffer = await file.arrayBuffer();

  // Decode using AudioContext
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Web Audio API not supported in this browser');
  const decodeCtx = new AudioCtx();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    // Safari/WebKit requires callback-based decode sometimes
    decoded = await new Promise((resolve, reject) => {
      decodeCtx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
    });
  } finally {
    // Close if supported to free resources
    try { decodeCtx.close && decodeCtx.close(); } catch {}
  }

  // Clamp end to buffer duration
  const clampedEnd = Math.min(end, decoded.duration);
  const segmentDuration = Math.max(0, clampedEnd - start);
  if (segmentDuration <= 0.0001) {
    throw new Error('Invalid segment duration');
  }

  // Extract segment into a new AudioBuffer (preserving original sampleRate & channels first)
  const sourceSampleRate = decoded.sampleRate;
  const sourceChannels = decoded.numberOfChannels;
  const startOffsetFrames = Math.floor(start * sourceSampleRate);
  const endOffsetFrames = Math.floor(clampedEnd * sourceSampleRate);
  const frameCount = Math.max(1, endOffsetFrames - startOffsetFrames);

  const tmpCtx = new OfflineAudioContext(sourceChannels, frameCount, sourceSampleRate);
  const buffer = tmpCtx.createBuffer(sourceChannels, frameCount, sourceSampleRate);
  for (let ch = 0; ch < sourceChannels; ch++) {
    const channelData = decoded.getChannelData(ch).slice(startOffsetFrames, endOffsetFrames);
    buffer.copyToChannel(channelData, ch, 0);
  }

  // Render to 16kHz mono using OfflineAudioContext
  const targetSampleRate = 16000;
  const targetChannels = 1;
  const targetFrames = Math.ceil(segmentDuration * targetSampleRate);
  const offline = new OfflineAudioContext(targetChannels, targetFrames, targetSampleRate);

  const src = offline.createBufferSource();
  // Downmix to mono if needed
  let downmixed;
  if (buffer.numberOfChannels === 1) {
    downmixed = buffer;
  } else {
    // Average channels to mono
    downmixed = offline.createBuffer(1, buffer.length, buffer.sampleRate);
    const mono = downmixed.getChannelData(0);
    for (let i = 0; i < buffer.length; i++) {
      let sum = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        sum += buffer.getChannelData(ch)[i] || 0;
      }
      mono[i] = sum / buffer.numberOfChannels;
    }
  }

  src.buffer = downmixed;
  src.connect(offline.destination);
  src.start(0);

  const rendered = await offline.startRendering();

  // Encode to 16-bit PCM WAV
  const wavBuffer = encodeWavPCM16(rendered.getChannelData(0), rendered.sampleRate);
  const base64 = arrayBufferToBase64(wavBuffer);
  return `data:audio/wav;base64,${base64}`;
}

function encodeWavPCM16(float32Array, sampleRate) {
  // Convert Float32 [-1,1] to PCM16
  const dataLength = float32Array.length * 2; // 16-bit
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // audio format = PCM
  view.setUint16(22, 1, true);  // channels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = sampleRate * blockAlign
  view.setUint16(32, 2, true);  // block align = channels * bytesPerSample
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}
