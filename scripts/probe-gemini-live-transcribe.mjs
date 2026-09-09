// Explicit billed diagnostic, not a product test. Never prints credentials or transport errors.
/* global Buffer, WebSocket, console */
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readGeminiCredentialPool } from '../e2e/support/liveProviderCredentials.js';
import process from 'node:process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const mediaArgument = process.argv.indexOf('--media');
const media = mediaArgument >= 0
  ? process.argv[mediaArgument + 1]
  : 'target/subtitle-benchmark/additional-media/fleurs-ko-1883.mp4';
if (!media || media.startsWith('--')) throw new Error('--media requires a file path');
const durationArguments = mediaArgument >= 0 ? [] : ['-t', '12.48'];
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', media,
  ...durationArguments, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
{ windowsHide: true, maxBuffer: 1024 * 1024 });
const key = readGeminiCredentialPool()[0].value;
if (process.argv.includes('--rust')) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const workspaceExecutable = join(process.cwd(), 'target/debug/examples/live_transcribe_smoke.exe');
  const cachedExecutable = join(process.env.LOCALAPPDATA, 'OSG-Development/cache/cargo/dev/debug/examples/live_transcribe_smoke.exe');
  const executable = existsSync(workspaceExecutable) ? workspaceExecutable : cachedExecutable;
  try {
    const output = execFileSync(executable, [], { input: Buffer.concat([header, pcm]),
      env: { ...process.env, GEMINI_API_KEY: key }, windowsHide: true, timeout: 60000,
      maxBuffer: 1024 * 1024 });
    process.stdout.write(output);
  } catch { console.error('Shipping Rust Live transport failed (details redacted)'); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`);
let ready;
const setup = new Promise((resolve) => { ready = resolve; });
let finalCount = 0;
let interimCount = 0;
let streamStartedAt = 0;
let firstFinalElapsedMs = null;
let finalText = '';
ws.onopen = () => ws.send(JSON.stringify({ setup: {
  model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] },
  inputAudioTranscription: { languageCodes: [], mode: 'SMART', ...(process.argv.includes('--word-timestamps') ? { wordTimestamp: true } : {}) },
} }));
ws.onmessage = async ({ data }) => {
  const raw = typeof data === 'string' ? data : await data.text();
  if (raw.length > 1024 * 1024) { ws.close(); return; }
  const event = JSON.parse(raw);
  if (event.setupComplete) ready(true);
  if (event.error) { console.log(JSON.stringify({ providerErrorCode: event.error.code })); ready(false); }
  const content = event.serverContent;
  if (content) {
    if (content.inputTranscription) {
      finalCount++;
      firstFinalElapsedMs ??= Date.now() - streamStartedAt;
      finalText += content.inputTranscription.text ?? '';
    }
    if (content.interimInputTranscription) interimCount++;
    console.log(JSON.stringify({ fields: Object.keys(content),
      elapsedMs: streamStartedAt ? Date.now() - streamStartedAt : null,
      finalBytes: content.inputTranscription?.text?.length ?? 0,
      interimFields: content.interimInputTranscription ? Object.keys(content.interimInputTranscription) : [],
      interimBytes: content.interimInputTranscription?.text?.length ?? 0,
    }));
  } else if (!event.setupComplete) console.log(JSON.stringify({ eventFields: Object.keys(event) }));
};
ws.onerror = () => { console.log('Live transport failed (details redacted)'); ready(false); };
ws.onclose = ({ code }) => { console.log(JSON.stringify({ closeCode: code, finalCount })); ready(false); };
const connected = await Promise.race([setup, delay(15000, false)]);
if (connected) {
  streamStartedAt = Date.now();
  const rateArgument = process.argv.indexOf('--rate');
  const rate = rateArgument >= 0 ? Number(process.argv[rateArgument + 1]) : 1;
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error('--rate must be between 0.5 and 2');
  for (let offset = 0; offset < pcm.length && ws.readyState === WebSocket.OPEN; offset += 3200) {
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.subarray(offset, offset + 3200).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    await delay(100 / rate);
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  await delay(8000);
}
ws.close();
console.log(JSON.stringify({ finalCount, interimCount, firstFinalElapsedMs,
  finalTextBytes: Buffer.byteLength(finalText),
  finalTextSha256: createHash('sha256').update(finalText).digest('hex') }));
if (!finalCount) process.exitCode = 1;
