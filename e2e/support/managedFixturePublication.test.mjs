import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cachedManagedFixture, managedFixtureIdentity, publishManagedFixture, reviewedToolProvenance,
} from './managedFixturePublication.js';

const withFixtureRoot = (context) => {
  const root = mkdtempSync(join(tmpdir(), 'osg-managed-fixture-'));
  const cacheRoot = join(root, 'fixture');
  const toolsRoot = join(root, 'tools');
  mkdirSync(cacheRoot);
  mkdirSync(toolsRoot);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cacheRoot, toolsRoot };
};

const toolIdentity = (toolsRoot, byte = 3) => {
  const ffmpeg = join(toolsRoot, 'ffmpeg.exe');
  const ffprobe = join(toolsRoot, 'ffprobe.exe');
  writeFileSync(ffmpeg, Buffer.alloc(137, byte));
  writeFileSync(ffprobe, Buffer.alloc(83, byte + 1));
  return reviewedToolProvenance({ storeRoot: toolsRoot, roles: { ffmpeg, ffprobe } });
};

const identity = (tools, overrides = {}) => managedFixtureIdentity({
  kind: 'hostile-fixture-test',
  recipe: overrides.recipe ?? { source: 'tone=220Hz', duration: 7_200, encoder: 'h264+aac' },
  source: overrides.source ?? { sha256: 'a'.repeat(64), sizeBytes: 203_077 },
  tools,
});

const canonicalProbe = (sizeBytes) => Object.freeze({
  durationSeconds: 7_200,
  sizeBytes,
  videoCodec: 'h264',
  audioCodec: 'aac',
});

const validateProbe = (value) => {
  assert.deepEqual(Object.keys(value ?? {}).sort(), [
    'audioCodec', 'durationSeconds', 'sizeBytes', 'videoCodec',
  ]);
  assert.equal(value.durationSeconds, 7_200);
  assert.equal(value.videoCodec, 'h264');
  assert.equal(value.audioCodec, 'aac');
  assert.ok(Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0);
  return Object.freeze({
    durationSeconds: value.durationSeconds,
    sizeBytes: value.sizeBytes,
    videoCodec: value.videoCodec,
    audioCodec: value.audioCodec,
  });
};

const publish = ({ cacheRoot, expectedFixture, bytes, name = 'long-source.mp4', ...options }) => {
  const candidate = join(cacheRoot, `.candidate-${Math.random().toString(16).slice(2)}.tmp.mp4`);
  writeFileSync(candidate, bytes);
  return publishManagedFixture({
    assertStillLive: options.assertStillLive ?? (() => cacheRoot),
    cacheRoot,
    candidate,
    expectedFixture,
    originalName: name,
    probe: canonicalProbe(bytes.byteLength),
    validateProbe,
    afterPayload: options.afterPayload,
  });
};

const cached = ({ cacheRoot, expectedFixture, name = 'long-source.mp4' }) => cachedManagedFixture({
  cacheRoot, expectedFixture, originalName: name, validateProbe,
});

test('a receipt binds one ordinary payload to its recipe, source and reviewed tools', (context) => {
  const { cacheRoot, toolsRoot } = withFixtureRoot(context);
  const expectedFixture = identity(toolIdentity(toolsRoot));
  const path = publish({ cacheRoot, expectedFixture, bytes: Buffer.from('trusted fixture bytes') });
  const selected = cached({ cacheRoot, expectedFixture });
  assert.equal(selected.path, path);
  assert.match(path, /[0-9a-f]{64}-long-source\.mp4$/u);

  assert.equal(cached({
    cacheRoot,
    expectedFixture: identity(toolIdentity(toolsRoot, 11)),
  }), null, 'a different reviewed tool identity reused the fixture');
  assert.equal(cached({
    cacheRoot,
    expectedFixture: identity(toolIdentity(toolsRoot, 11), { recipe: { source: 'silence' } }),
  }), null, 'a different recipe reused the fixture');
});

test('substitute, silent, corrupt and missing payloads are never selected', (context) => {
  const { root, toolsRoot } = withFixtureRoot(context);
  const expectedFixture = identity(toolIdentity(toolsRoot));
  const original = Buffer.from('non-silent speech and tone fixture');
  for (const [label, mutate] of [
    ['substitute', (path) => writeFileSync(path, Buffer.alloc(original.length, 0x5a))],
    ['silence', (path) => writeFileSync(path, Buffer.alloc(original.length, 0))],
    ['corrupt', (path) => writeFileSync(path, Buffer.from('truncated'))],
    ['missing', (path) => rmSync(path)],
  ]) {
    const caseRoot = join(root, label);
    mkdirSync(caseRoot);
    const path = publish({ cacheRoot: caseRoot, expectedFixture, bytes: original });
    mutate(path);
    assert.equal(cached({ cacheRoot: caseRoot, expectedFixture }), null, `${label} was selected`);
  }
});

test('symlinked and multiply-linked payloads are rejected despite matching bytes', (context) => {
  const { root, toolsRoot } = withFixtureRoot(context);
  const expectedFixture = identity(toolIdentity(toolsRoot));
  const hardRoot = join(root, 'hard');
  const symbolicTarget = join(root, 'symbolic-target');
  const symbolicRoot = join(root, 'symbolic-cache');
  mkdirSync(hardRoot);
  mkdirSync(symbolicTarget);

  const hardPayload = publish({ cacheRoot: hardRoot, expectedFixture, bytes: Buffer.from('hard') });
  linkSync(hardPayload, join(root, 'second-hard-link.mp4'));
  assert.equal(cached({ cacheRoot: hardRoot, expectedFixture }), null);

  publish({ cacheRoot: symbolicTarget, expectedFixture, bytes: Buffer.from('symbolic') });
  // A directory junction needs no Windows Developer Mode privilege and exercises the same
  // realpath refusal for both receipt and payload without making the test conditional.
  symlinkSync(symbolicTarget, symbolicRoot, 'junction');
  assert.equal(cached({ cacheRoot: symbolicRoot, expectedFixture }), null);
});

test('wrong and malformed receipts cannot select a matching payload', (context) => {
  const { root, toolsRoot } = withFixtureRoot(context);
  const expectedFixture = identity(toolIdentity(toolsRoot));
  for (const [label, mutate] of [
    ['wrong-recipe', (receipt) => { receipt.fixture.recipeSha256 = '0'.repeat(64); }],
    ['wrong-source', (receipt) => { receipt.fixture.source.sha256 = '1'.repeat(64); }],
    ['wrong-tool', (receipt) => { receipt.fixture.tools.ffmpeg.sha256 = '2'.repeat(64); }],
    ['wrong-hash', (receipt) => { receipt.payload.sha256 = '3'.repeat(64); }],
    ['wrong-probe', (receipt) => { receipt.probe.durationSeconds = 60; }],
    ['extra-field', (receipt) => { receipt.unreviewed = true; }],
  ]) {
    const caseRoot = join(root, label);
    mkdirSync(caseRoot);
    publish({ cacheRoot: caseRoot, expectedFixture, bytes: Buffer.from(label) });
    const receiptPath = join(caseRoot, 'receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    mutate(receipt);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.equal(cached({ cacheRoot: caseRoot, expectedFixture }), null, `${label} was selected`);
  }

  const malformed = join(root, 'malformed');
  mkdirSync(malformed);
  writeFileSync(join(malformed, 'receipt.json'), '{not-json\n');
  assert.equal(cached({ cacheRoot: malformed, expectedFixture }), null);
});

test('interruption before receipt commit preserves the prior generation byte-for-byte', (context) => {
  const { cacheRoot, toolsRoot } = withFixtureRoot(context);
  const expectedFixture = identity(toolIdentity(toolsRoot));
  const first = publish({ cacheRoot, expectedFixture, bytes: Buffer.from('first generation') });
  const receiptBefore = readFileSync(join(cacheRoot, 'receipt.json'));
  const payloadBefore = readFileSync(first);

  assert.throws(
    () => publish({
      cacheRoot,
      expectedFixture,
      bytes: Buffer.from('replacement generation'),
      afterPayload: () => { throw new Error('simulated interruption'); },
    }),
    /simulated interruption/u,
  );
  assert.deepEqual(readFileSync(join(cacheRoot, 'receipt.json')), receiptBefore);
  assert.deepEqual(readFileSync(first), payloadBefore);
  assert.equal(cached({ cacheRoot, expectedFixture }).path, first);
});

test('stale authority leaves an unreferenced orphan and never rolls persistent state back', (context) => {
  const { cacheRoot, toolsRoot } = withFixtureRoot(context);
  const expectedFixture = identity(toolIdentity(toolsRoot));
  const first = publish({ cacheRoot, expectedFixture, bytes: Buffer.from('first generation') });
  const receiptBefore = readFileSync(join(cacheRoot, 'receipt.json'));
  let live = true;
  assert.throws(
    () => publish({
      cacheRoot,
      expectedFixture,
      bytes: Buffer.from('orphaned replacement'),
      assertStillLive: () => {
        if (!live) throw new Error('stale authority');
        return cacheRoot;
      },
      afterPayload: () => { live = false; },
    }),
    /stale authority/u,
  );
  assert.deepEqual(readFileSync(join(cacheRoot, 'receipt.json')), receiptBefore);
  assert.equal(cached({ cacheRoot, expectedFixture }).path, first);
  assert.ok(existsSync(first));
});
