import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [generatedPath, captionsPath, videoId] = process.argv.slice(2);
if (!generatedPath || !captionsPath || !videoId) {
  throw new Error('usage: node scripts/benchmark-transcript-against-youtube.mjs <db-or-generated-cues.json> <youtube.json3> <video-id>');
}

const normalize = (text) => text.toLocaleLowerCase('en-US')
  .normalize('NFKC')
  .replace(/[^\p{L}\p{N}']+/gu, '')
  .replace(/^'+|'+$/gu, '');
const tokens = (text) => text.trim().split(/\s+/u).map(normalize).filter(Boolean);

const captions = JSON.parse(readFileSync(captionsPath, 'utf8'));
const reference = captions.events.flatMap((event) => (event.segs || []).flatMap((segment) => {
  if (!segment.utf8?.trim()) return [];
  const words = tokens(segment.utf8);
  const startMs = Number(event.tStartMs || 0) + Number(segment.tOffsetMs || 0);
  return words.map((text) => ({ text, startMs }));
}));

let revision;
let generated;
if (generatedPath.toLocaleLowerCase('en-US').endsWith('.json')) {
  const evidence = JSON.parse(readFileSync(generatedPath, 'utf8'));
  if (evidence.schemaVersion !== 1 || !Array.isArray(evidence.cues)) {
    throw new Error('generated-cues evidence has an unsupported shape');
  }
  revision = { model: 'gemini-transcribe-live', durationMs: evidence.durationSeconds * 1000 };
  generated = evidence.cues.flatMap(({ text, start_ms: startMs }) => (
    tokens(text).map((word) => ({ text: word, startMs }))
  ));
} else {
  const database = new DatabaseSync(generatedPath, { readOnly: true });
  revision = database.prepare(`
  SELECT hex(r.id) id, r.word_count wordCount, r.source_range_end_ms durationMs, r.model
  FROM transcript_revisions r JOIN projects p ON p.id = r.project_id
  WHERE p.title = ? AND r.state = 'completed'
  ORDER BY r.updated_at_ms DESC LIMIT 1
`).get(videoId);
  if (!revision) throw new Error(`no completed transcript revision for ${videoId}`);
  generated = database.prepare(`
  SELECT w.text, w.start_ms startMs FROM transcript_words w
  JOIN transcript_revisions r ON r.id = w.revision_id
  WHERE hex(r.id) = ? ORDER BY w.ordinal
`).all(revision.id).flatMap(({ text, startMs }) => tokens(text).map((word) => ({ text: word, startMs })));
}

const rows = reference.length + 1;
const columns = generated.length + 1;
const directions = new Uint8Array(rows * columns); // 1 diagonal, 2 delete reference, 3 insert generated
let previous = new Uint32Array(columns);
let current = new Uint32Array(columns);
for (let j = 0; j < columns; j += 1) previous[j] = j;
for (let i = 1; i < rows; i += 1) {
  current[0] = i;
  directions[i * columns] = 2;
  for (let j = 1; j < columns; j += 1) {
    const substitution = previous[j - 1] + (reference[i - 1].text === generated[j - 1].text ? 0 : 1);
    const deletion = previous[j] + 1;
    const insertion = current[j - 1] + 1;
    const best = Math.min(substitution, deletion, insertion);
    current[j] = best;
    directions[i * columns + j] = best === substitution ? 1 : best === deletion ? 2 : 3;
  }
  [previous, current] = [current, previous];
}

let i = reference.length;
let j = generated.length;
let substitutions = 0;
let deletions = 0;
let insertions = 0;
const matches = [];
const missing = [];
while (i > 0 || j > 0) {
  const direction = directions[i * columns + j];
  if (i > 0 && j > 0 && direction === 1) {
    if (reference[i - 1].text === generated[j - 1].text) matches.push([i - 1, j - 1]);
    else substitutions += 1;
    i -= 1;
    j -= 1;
  } else if (i > 0 && (j === 0 || direction === 2)) {
    missing.push(i - 1);
    deletions += 1;
    i -= 1;
  } else {
    insertions += 1;
    j -= 1;
  }
}
matches.reverse();
missing.reverse();

const absoluteDrifts = matches.map(([r, g]) => generated[g].startMs - reference[r].startMs).sort((a, b) => a - b);
const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
const minuteCount = Math.ceil(revision.durationMs / 60_000);
const minuteCoverage = Array.from({ length: minuteCount }, (_, minute) => {
  const start = minute * 60_000;
  const end = start + 60_000;
  const ref = reference.filter((word) => word.startMs >= start && word.startMs < end).length;
  const out = generated.filter((word) => word.startMs >= start && word.startMs < end).length;
  return { minute, referenceWords: ref, generatedWords: out, ratio: ref ? out / ref : null };
});
const weakestMinutes = minuteCoverage.filter(({ referenceWords }) => referenceWords >= 10)
  .sort((a, b) => a.ratio - b.ratio).slice(0, 5);

console.log(JSON.stringify({
  videoId,
  model: revision.model,
  durationSeconds: revision.durationMs / 1000,
  referenceWords: reference.length,
  generatedWords: generated.length,
  exactAlignedWords: matches.length,
  exactRecall: matches.length / reference.length,
  exactPrecision: matches.length / generated.length,
  wordErrorRate: (substitutions + deletions + insertions) / reference.length,
  substitutions,
  missingReferenceWords: deletions,
  insertedGeneratedWords: insertions,
  timingDriftMs: {
    median: percentile(absoluteDrifts, 0.5),
    p10: percentile(absoluteDrifts, 0.1),
    p90: percentile(absoluteDrifts, 0.9),
  },
  weakestMinutes,
  minuteCoverage,
}, null, 2));
