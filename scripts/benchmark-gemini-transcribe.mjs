// Explicit, billed provider benchmark. This is NOT an installed-app journey.
// No reference transcript, vocabulary hints or reference timing enters a request.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { readGeminiCredentialPool } from '../e2e/support/liveProviderCredentials.js';
import { scoreSubtitleTiming } from '../e2e/support/subtitleTimingQuality.js';

const slots = Number(process.argv[2] ?? 1);
assert.ok(Number.isInteger(slots) && slots >= 1 && slots <= 20, 'Supply 1..20 credential slots');
const root = resolve('target/subtitle-benchmark');
const output = join(root, 'transcribe-runs', new Date().toISOString().replace(/[:.]/gu, '-'));
mkdirSync(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = [['real-video', 'ES2004a'], ['additional-media', 'cortez-feel'], ['additional-media', 'fleurs-ko-1883']];
const fixtures = cases.map(([set, id]) => {
  const directory = join(root, set);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  const fixture = manifest.cases.find(item => item.id === id);
  assert.ok(fixture, `Missing fixture ${id}`);
  for (const file of [fixture.file, fixture.reference]) assert.equal(file, file.split(/[\\/]/u).at(-1));
  const source = join(directory, fixture.file);
  assert.equal(hash(readFileSync(source)), fixture.sha256, `Source hash mismatch: ${id}`);
  const referenceBytes = readFileSync(join(directory, fixture.reference));
  assert.equal(hash(referenceBytes), fixture.referenceSha256, `Reference hash mismatch: ${id}`);
  const audio = join(output, `${id}.wav`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', source,
    '-vn', '-ac', '1', '-ar', '16000', audio], { windowsHide: true });
  const bytes = readFileSync(audio);
  assert.ok(bytes.length <= 10_000_000, 'Inline diagnostic audio limit exceeded');
  return { id, fixture, referenceBytes, bytes, audioSha256: hash(bytes) };
});
const pool = readGeminiCredentialPool();
assert.ok(pool.length >= slots, 'Requested credential slots are not configured');
const results = [];
for (let slot = 0; slot < slots; slot++) for (const fixture of fixtures) {
  const started = Date.now();
  const report = { fixture: fixture.id, slot: slot + 1, model: 'gemini-3.5-transcribe',
    sourceSha256: fixture.fixture.sha256, audioSha256: fixture.audioSha256,
    transport: 'Interactions SSE', input: '16-kHz mono WAV; independent provider check',
    observations: [] };
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { 'x-goog-api-key': pool[slot].value, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: 'gemini-3.5-transcribe', stream: true, store: false,
        input: [{ type: 'audio', mime_type: 'audio/wav', data: fixture.bytes.toString('base64') }],
        generation_config: { transcription_config: {
          mode: { type: 'verbatim', timestamp_granularities: ['word'] },
        } },
      }),
    });
    report.httpStatus = response.status;
    assert.ok(response.ok, `Provider HTTP ${response.status}`);
    const decoder = new TextDecoder();
    let pending = '', size = 0, stopped = false;
    const words = [];
    const consume = line => {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') return;
      const event = JSON.parse(line.slice(5));
      if (event.event_type === 'error') throw new Error('Provider stream error');
      const next = event.event_type === 'step.delta'
        ? (event.delta?.annotations ?? []).filter(annotation => annotation.type === 'word_info')
        : event.event_type === 'step.start'
          ? (event.step?.content ?? []).flatMap(content => content.annotations ?? [])
            .filter(annotation => annotation.type === 'word_info')
          : [];
      assert.ok(!stopped || next.length === 0, 'Words arrived after completion');
      if (event.event_type === 'interaction.completed') {
        assert.equal(event.interaction?.status, 'completed', 'Provider did not complete normally');
        stopped = true;
      }
      words.push(...next);
      report.observations.push({ elapsedMs: Date.now() - started, words: next.length,
        eventType: event.event_type });
    };
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      assert.ok(size <= 8 * 1024 * 1024, 'Provider output exceeded 8 MiB');
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, newline).trim());
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending.trim());
    assert.ok(stopped && words.length, 'Incomplete response or absent word annotations');
    const offset = value => {
      assert.match(value, /^\d+(?:\.\d{1,9})?s$/u, 'Invalid provider duration');
      return Number(value.slice(0, -1)) * 1000;
    };
    const cues = words.map(word => {
      const cue = { text: word.text, start_ms: offset(word.start_offset), end_ms: offset(word.end_offset) };
      assert.ok(typeof cue.text === 'string' && cue.text.trim() && cue.start_ms <= cue.end_ms
        && cue.end_ms <= fixture.fixture.durationSeconds * 1000 + 100, 'Invalid timed word');
      return cue;
    });
    report.cues = cues;
    report.quality = scoreSubtitleTiming(JSON.parse(fixture.referenceBytes), cues);
    report.status = 'completed';
  } catch (error) {
    // Never archive request headers, credential values or arbitrary provider errors.
    report.status = 'failed';
    report.failure = error.name;
    process.exitCode = 1;
  }
  report.elapsedMs = Date.now() - started;
  writeFileSync(join(output, `${fixture.id}-slot-${slot + 1}.json`), JSON.stringify(report, null, 2));
  results.push({ fixture: report.fixture, slot: report.slot, status: report.status,
    httpStatus: report.httpStatus, elapsedMs: report.elapsedMs, quality: report.quality
      ? { coverage: report.quality.referenceWordCoverage, wer: report.quality.wordErrorRate,
        start: report.quality.start, end: report.quality.end } : null });
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync(join(output, 'summary.json'), JSON.stringify({ evidence: 'provider-only; not an app pass', results }, null, 2));
console.log(`Evidence: ${output}`);
