import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

import {
  analyzePcm16,
  bestEnvelopeCorrelation,
  expectedNarrationPlacements,
  verifyCueAlignedSignal,
  verifyNarrationGenerationOwnership,
  verifyNarrationOnlyExportMix,
  verifySingleProjectArtifact,
} from './narrationJourneyOracle.js';

const PROJECT = '018f0000-0000-7000-8000-000000000001';
const JOB = '018f0000000070008000000000000011';
const CUE_A = '018f0000-0000-7000-8000-000000000021';
const CUE_B = '018f0000-0000-7000-8000-000000000022';
const ARTIFACT_A = '018f0000-0000-7000-8000-000000000031';
const ARTIFACT_B = '018f0000-0000-7000-8000-000000000032';
const hex = value => value.replaceAll('-', '');

const ownershipFixture = () => {
  const before = { jobs: [], artifacts: [] };
  const after = {
    projects: [{ id: hex(PROJECT), state_version: 5 }],
    cues: [
      { id: hex(CUE_A), ordinal: 1, start_ms: 500, end_ms: 1_500, text: 'First' },
      { id: hex(CUE_B), ordinal: 2, start_ms: 2_000, end_ms: 3_000, text: 'Second' },
    ],
    jobs: [{ id: JOB, kind: 'synthesizeNarration', state: 'succeeded' }],
    artifacts: [
      {
        id: hex(ARTIFACT_A), project_id: hex(PROJECT), job_id: JOB,
        kind: 'narrationOutput', relative_path: 'a.mp3', size_bytes: 1_024, state: 'ready',
      },
      {
        id: hex(ARTIFACT_B), project_id: hex(PROJECT), job_id: JOB,
        kind: 'narrationOutput', relative_path: 'b.mp3', size_bytes: 2_048, state: 'ready',
      },
    ],
  };
  const records = [{
    key: `${PROJECT}:original`,
    value: {
      schemaVersion: 1,
      projectId: PROJECT,
      projectStateVersion: 5,
      source: 'original',
      results: [
        {
          subtitleId: 1, text: 'First', artifactId: ARTIFACT_A, method: 'gtts',
          outputIndex: 1, originalIds: [1], startMicros: 500_000, endMicros: 1_500_000,
        },
        {
          subtitleId: 2, text: 'Second', artifactId: ARTIFACT_B, method: 'gtts',
          outputIndex: 2, originalIds: [2], startMicros: 2_000_000, endMicros: 3_000_000,
        },
      ],
    },
  }];
  const surface = { succeeded: 2, pending: 0, failed: 0 };
  return { before, after, records, surface };
};

const pcm = ({ seconds, signals, sampleRate = 16_000 }) => {
  const samples = Math.round(seconds * sampleRate);
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate;
    const active = signals.some(([start, end]) => time >= start && time < end);
    const value = active ? Math.round(Math.sin(2 * Math.PI * 440 * time) * 12_000) : 0;
    bytes.writeInt16LE(value, index * 2);
  }
  return bytes;
};

test('generation ownership binds every durable cue to one unique result and artifact', () => {
  const fixture = ownershipFixture();
  const verified = verifyNarrationGenerationOwnership(fixture);
  assert.equal(verified.bindings.length, 2);
  assert.equal(verified.artifacts.length, 2);
  assert.equal(verified.job.id, JOB);
});

test('partial UI, partial artifacts, duplicate capabilities and stale timings are hard failures', () => {
  const partialUi = ownershipFixture();
  partialUi.surface.succeeded = 1;
  assert.throws(() => verifyNarrationGenerationOwnership(partialUi), /visible narration rows/u);

  const partialArtifacts = ownershipFixture();
  partialArtifacts.after.artifacts.pop();
  assert.throws(() => verifyNarrationGenerationOwnership(partialArtifacts), /exactly one narration artifact/u);

  const duplicate = ownershipFixture();
  duplicate.records[0].value.results[1].artifactId = ARTIFACT_A;
  assert.throws(() => verifyNarrationGenerationOwnership(duplicate), /artifact IDs contains duplicates/u);

  const staleTiming = ownershipFixture();
  staleTiming.records[0].value.results[0].startMicros += 1;
  assert.throws(() => verifyNarrationGenerationOwnership(staleTiming), /wrong start time/u);

  const foreignProject = ownershipFixture();
  foreignProject.after.artifacts[0].project_id = '018f0000000070008000000000000099';
  assert.throws(() => verifyNarrationGenerationOwnership(foreignProject), /escaped the narration project/u);
});

test('single-artifact ownership refuses duplicate jobs, missing artifacts and cross-project output', () => {
  const before = { jobs: [], artifacts: [] };
  const after = {
    jobs: [{ id: JOB, kind: 'alignNarration', state: 'succeeded' }],
    artifacts: [{
      id: hex(ARTIFACT_A), project_id: hex(PROJECT), job_id: JOB,
      kind: 'alignedNarration', state: 'ready',
    }],
  };
  assert.equal(verifySingleProjectArtifact({
    before, after, expectedProjectId: PROJECT,
    jobKind: 'alignNarration', artifactKind: 'alignedNarration',
  }).artifact.id, hex(ARTIFACT_A));

  after.jobs.push({ id: `${JOB.slice(0, -1)}2`, kind: 'alignNarration', state: 'succeeded' });
  assert.throws(() => verifySingleProjectArtifact({
    before, after, expectedProjectId: PROJECT,
    jobKind: 'alignNarration', artifactKind: 'alignedNarration',
  }), /exactly one native job/u);
});

test('placement oracle preserves requested starts and bounds overlap recovery', () => {
  const fixture = ownershipFixture();
  fixture.after.cues[0].end_ms = 800;
  fixture.after.cues[1].start_ms = 900;
  const bindings = fixture.after.cues.map(cue => ({ cue }));
  const placements = expectedNarrationPlacements(bindings, [1.2, 0.5]);
  assert.deepEqual(
    placements.map(({ start, shifted }) => ({ start, shifted })),
    [{ start: 0.5, shifted: false }, { start: 1.5, shifted: true }],
  );
});

test('cue-aligned audio requires independently decoded signal inside every onset window', () => {
  const placements = [
    { cueId: hex(CUE_A), start: 0.5, end: 1.0 },
    { cueId: hex(CUE_B), start: 2.0, end: 2.5 },
  ];
  const valid = analyzePcm16(pcm({ seconds: 3, signals: [[0.52, 0.9], [2.04, 2.4]] }));
  const verified = verifyCueAlignedSignal({ analysis: valid, placements, label: 'fixture' });
  assert.equal(verified.onset.length, 2);

  const missingSecond = analyzePcm16(pcm({ seconds: 3, signals: [[0.52, 0.9]] }));
  assert.throws(
    () => verifyCueAlignedSignal({ analysis: missingSecond, placements, label: 'fixture' }),
    /no decoded speech for cue 2/u,
  );
  const prerollLeak = analyzePcm16(pcm({
    seconds: 3, signals: [[0.05, 0.3], [0.52, 0.9], [2.04, 2.4]],
  }));
  assert.throws(
    () => verifyCueAlignedSignal({ analysis: prerollLeak, placements, label: 'fixture' }),
    /leaked audio before the first cue/u,
  );
});

test('narration-only final mix matches aligned speech and rejects muted-source leakage', () => {
  const placements = [
    { cueId: hex(CUE_A), start: 0.5, end: 1.0 },
    { cueId: hex(CUE_B), start: 2.0, end: 2.5 },
  ];
  const aligned = analyzePcm16(pcm({ seconds: 3.25, signals: [[0.52, 0.9], [2.04, 2.4]] }));
  const exported = analyzePcm16(pcm({ seconds: 6, signals: [[0.52, 0.9], [2.04, 2.4]] }));
  const source = analyzePcm16(pcm({ seconds: 6, signals: [[0, 6]] }));
  const verified = verifyNarrationOnlyExportMix({
    aligned, exported, source, placements, sourceDurationSeconds: 6,
  });
  assert.ok(verified.correlation.correlation > 0.99);

  const unpaddedExport = analyzePcm16(pcm({
    seconds: 3.25, signals: [[0.52, 0.9], [2.04, 2.4]],
  }));
  const unpadded = verifyNarrationOnlyExportMix({
    aligned, exported: unpaddedExport, source, placements, sourceDurationSeconds: 6,
  });
  assert.equal(unpadded.exportedTail.maximumRms, 0);

  const leaked = analyzePcm16(pcm({
    seconds: 6, signals: [[0.52, 0.9], [2.04, 2.4], [3.5, 5.9]],
  }));
  assert.throws(
    () => verifyNarrationOnlyExportMix({
      aligned, exported: leaked, source, placements, sourceDurationSeconds: 6,
    }),
    /original audio leaked/u,
  );
});

test('envelope correlation tolerates only a bounded codec priming offset', () => {
  const left = analyzePcm16(pcm({ seconds: 2, signals: [[0.5, 0.8], [1.2, 1.5]] }));
  const right = analyzePcm16(pcm({ seconds: 2, signals: [[0.56, 0.86], [1.26, 1.56]] }));
  const result = bestEnvelopeCorrelation(left, right, 6);
  assert.ok(result.correlation > 0.99);
  assert.ok(Math.abs(result.offsetWindows) <= 3);
});

test('the real journey keeps provider smoke and deterministic local proof explicitly separate', () => {
  const source = readFileSync(
    new URL('../journeys/narrationGeneration.journey.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /network-dependent gTTS provider smoke/iu);
  assert.match(source, /deterministic local alignment and render proof/iu);
  assert.match(source, /verifyNarrationGenerationOwnership/u);
  assert.match(source, /verifyCueAlignedSignal/u);
  assert.match(source, /verifyNarrationOnlyExportMix/u);
  assert.match(source, /#original-audio-volume/u);
  assert.match(source, /#narration-volume/u);
  assert.match(source, /data-osg-action="render-video"/u);
});
