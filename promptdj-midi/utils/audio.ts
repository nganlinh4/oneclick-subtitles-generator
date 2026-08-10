/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export async function decodeAudioData(
  data: Uint8Array,
  context: AudioContext,
  sampleRate: number,
  channelCount: number,
): Promise<AudioBuffer> {
  if (channelCount < 1 || data.byteLength % (2 * channelCount) !== 0) {
    throw new Error('Invalid PCM audio');
  }
  const frameCount = data.byteLength / 2 / channelCount;
  const buffer = context.createBuffer(channelCount, frameCount, sampleRate);
  const samples = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const output = buffer.getChannelData(channel);
    for (let frame = 0; frame < frameCount; frame += 1) {
      output[frame] = samples[frame * channelCount + channel] / 32_768;
    }
  }
  return buffer;
}
