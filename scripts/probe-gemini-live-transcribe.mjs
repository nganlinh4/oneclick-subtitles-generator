// Explicit billed diagnostic, not a product test. Never prints credentials or transport errors.
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readGeminiCredentialPool } from '../e2e/support/liveProviderCredentials.js';
import process from 'node:process';

const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i',
  'target/subtitle-benchmark/additional-media/fleurs-ko-1883.mp4',
  '-t', '12.48', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
{ windowsHide: true, maxBuffer: 1024 * 1024 });
const key = readGeminiCredentialPool()[0].value;
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`);
let ready;
const setup = new Promise((resolve) => { ready = resolve; });
let finalCount = 0;
ws.onopen = () => ws.send(JSON.stringify({ setup: {
  model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] },
  inputAudioTranscription: { languageCodes: [], ...(process.argv.includes('--word-timestamps') ? { wordTimestamp: true } : {}) },
} }));
ws.onmessage = async ({ data }) => {
  const raw = typeof data === 'string' ? data : await data.text();
  if (raw.length > 1024 * 1024) { ws.close(); return; }
  const event = JSON.parse(raw);
  if (event.setupComplete) ready(true);
  if (event.error) { console.log(JSON.stringify({ providerErrorCode: event.error.code })); ready(false); }
  const content = event.serverContent;
  if (content) {
    if (content.inputTranscription) finalCount++;
    console.log(JSON.stringify({ fields: Object.keys(content),
      final: content.inputTranscription ?? null,
      interimFields: content.interimInputTranscription ? Object.keys(content.interimInputTranscription) : [],
    }));
  } else if (!event.setupComplete) console.log(JSON.stringify({ eventFields: Object.keys(event) }));
};
ws.onerror = () => { console.log('Live transport failed (details redacted)'); ready(false); };
ws.onclose = ({ code }) => { console.log(JSON.stringify({ closeCode: code, finalCount })); ready(false); };
const connected = await Promise.race([setup, delay(15000, false)]);
if (connected) {
  for (let offset = 0; offset < pcm.length && ws.readyState === WebSocket.OPEN; offset += 3200) {
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.subarray(offset, offset + 3200).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    await delay(100);
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  await delay(8000);
}
ws.close();
if (!finalCount) process.exitCode = 1;
