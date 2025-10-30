// Utility to trim silent parts from an audio Blob and return a new WAV Blob
// Removes all internal silent segments longer than a configurable duration,
// as well as leading/trailing silence.

export async function trimSilenceFromBlob(
  blob,
  {
    // Threshold as linear amplitude (0..1). ~0.003 ~ -50 dBFS, ~0.01 ~ -40 dBFS
    silenceThreshold = 0.003,
    // Minimum duration in ms to consider as silence to be removed
    minSilenceMs = 180,
    // Analysis window in ms for RMS computation
    analysisWindowMs = 20,
  } = {}
) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  const { numberOfChannels, length, sampleRate } = audioBuffer;

  // Read channel data
  const channels = new Array(numberOfChannels)
    .fill(0)
    .map((_, ch) => audioBuffer.getChannelData(ch));

  // Compute RMS per window using max across channels to detect silence robustly
  const windowSize = Math.max(1, Math.floor((sampleRate * analysisWindowMs) / 1000));
  const totalWindows = Math.ceil(length / windowSize);
  const rms = new Float32Array(totalWindows);

  for (let w = 0; w < totalWindows; w++) {
    const start = w * windowSize;
    const end = Math.min(length, start + windowSize);
    let sumSqMax = 0;
    let count = end - start;
    // Use a simple max-of-channel RMS per window
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = channels[ch];
      let sumSq = 0;
      for (let i = start; i < end; i++) {
        const s = data[i];
        sumSq += s * s;
      }
      const chRms = Math.sqrt(sumSq / Math.max(1, count));
      if (chRms > sumSqMax) sumSqMax = chRms;
    }
    rms[w] = sumSqMax;
  }

  // Identify silent windows
  const minSilenceWindows = Math.max(1, Math.round((minSilenceMs / analysisWindowMs)));
  const silent = new Array(totalWindows).fill(false);
  for (let w = 0; w < totalWindows; w++) {
    silent[w] = rms[w] < silenceThreshold;
  }

  // Collapse consecutive silent windows >= minSilenceWindows into removable ranges
  const removableRanges = [];
  let runStart = -1;
  for (let w = 0; w < totalWindows; w++) {
    if (silent[w]) {
      if (runStart === -1) runStart = w;
    } else {
      if (runStart !== -1) {
        const runLen = w - runStart;
        if (runLen >= minSilenceWindows) {
          const startSample = runStart * windowSize;
          const endSample = Math.min(length, w * windowSize);
          removableRanges.push([startSample, endSample]);
        }
        runStart = -1;
      }
    }
  }
  if (runStart !== -1) {
    const runLen = totalWindows - runStart;
    if (runLen >= minSilenceWindows) {
      const startSample = runStart * windowSize;
      const endSample = length;
      removableRanges.push([startSample, endSample]);
    }
  }

  // If nothing to remove, return original blob
  if (removableRanges.length === 0) {
    try { audioCtx.close(); } catch {}
    return blob;
  }

  // Merge overlapping ranges just in case
  removableRanges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of removableRanges) {
    if (!merged.length) { merged.push(r); continue; }
    const last = merged[merged.length - 1];
    if (r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push(r);
    }
  }

  // Build keep segments (inverse of merged silent ranges)
  const keepSegments = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (cursor < s) keepSegments.push([cursor, s]);
    cursor = e;
  }
  if (cursor < length) keepSegments.push([cursor, length]);

  // Calculate total kept samples
  let totalKeep = 0;
  for (const [s, e] of keepSegments) totalKeep += (e - s);

  // If nothing kept, return original blob
  if (totalKeep === 0) {
    try { audioCtx.close(); } catch {}
    return blob;
  }

  // Create interleaved PCM 16-bit buffer
  const outLength = totalKeep;
  const bytesPerSample = 2; // 16-bit
  const numChannels = numberOfChannels;
  const interleaved = new Int16Array(outLength * numChannels);

  let writeIndex = 0;
  for (const [s, e] of keepSegments) {
    for (let i = s; i < e; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = channels[ch][i];
        // Convert float [-1,1] to 16-bit PCM
        let v = Math.max(-1, Math.min(1, sample));
        v = v < 0 ? v * 0x8000 : v * 0x7FFF;
        interleaved[writeIndex++] = v | 0;
      }
    }
  }

  const wavBuffer = encodeWAV(interleaved, {
    sampleRate,
    numChannels,
    bytesPerSample,
  });

  try { audioCtx.close(); } catch {}
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function encodeWAV(interleavedInt16, { sampleRate, numChannels, bytesPerSample }) {
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = interleavedInt16.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM data
  let offset = 44;
  for (let i = 0; i < interleavedInt16.length; i++) {
    view.setInt16(offset, interleavedInt16[i], true);
    offset += 2;
  }

  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

