import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REAL_VIDEO, cachedRealVideo, createRealMediaBootstrapForTest, ensureRealVideo,
  verifyRealVideoProbe,
} from './realMedia.js';

const probeResult = Object.freeze({
  format: { duration: String(REAL_VIDEO.durationSeconds), format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 426, height: 240 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});
const semanticProbe = () => verifyRealVideoProbe(probeResult);
const mediaBytes = (byte) => Buffer.alloc(60_000, byte);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const withAssetRoot = (context) => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'osg-real-media-assets-'));
  context.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  return { assetRoot, cacheRoot: join(assetRoot, 'real-media') };
};

const acquisitionDouble = ({ byte = 7, resolveCalls = [], downloadArgs = [] } = {}) => ({
  assertLease: () => undefined,
  resolveTool: ({ tool, role }) => {
    resolveCalls.push({ tool, role });
    return `${tool}-${role}.exe`;
  },
  execute: (executable, args) => {
    if (executable === 'yt-dlp-yt-dlp.exe') {
      downloadArgs.push([...args]);
      const output = args[args.indexOf('--output') + 1];
      writeFileSync(output, mediaBytes(byte));
      return `${REAL_VIDEO.id}\t${output}\n`;
    }
    assert.equal(executable, 'media-tools-ffprobe.exe');
    return JSON.stringify(probeResult);
  },
});

test('a valid receipt reuses media without resolving or re-hashing native tools', (context) => {
  const { cacheRoot } = withAssetRoot(context);
  const resolveCalls = [];
  const downloadArgs = [];
  const first = createRealMediaBootstrapForTest({
    cacheRoot,
    ...acquisitionDouble({ resolveCalls, downloadArgs }),
  }).ensure();
  assert.deepEqual(resolveCalls, [
    { tool: 'yt-dlp', role: 'yt-dlp' },
    { tool: 'deno', role: 'deno' },
    { tool: 'media-tools', role: 'ffmpeg' },
    { tool: 'media-tools', role: 'ffprobe' },
  ]);
  assert.deepEqual(
    downloadArgs[0].slice(0, 2),
    ['--js-runtimes', 'deno:deno-deno.exe'],
    'bootstrap must use the same reviewed JavaScript runtime contract as the product downloader',
  );
  assert.equal(
    downloadArgs[0][downloadArgs[0].indexOf('--ffmpeg-location') + 1],
    '.',
    'bootstrap must merge the provider video/audio pair with reviewed FFmpeg',
  );
  assert.equal(
    downloadArgs[0][downloadArgs[0].indexOf('--format') + 1],
    'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio',
  );

  let toolResolutionAttempts = 0;
  const reused = createRealMediaBootstrapForTest({
    cacheRoot,
    execute: () => assert.fail('valid media reuse must not execute a native tool'),
    resolveTool: () => {
      toolResolutionAttempts += 1;
      assert.fail('valid media reuse must not verify or hash the native-tools tree');
    },
  }).ensure();
  assert.equal(reused, first);
  assert.equal(toolResolutionAttempts, 0);
});

test('an interrupted replacement preserves the prior valid payload and receipt byte-for-byte', (context) => {
  const { cacheRoot } = withAssetRoot(context);
  mkdirSync(cacheRoot, { recursive: true });
  const firstCandidate = join(cacheRoot, '.first.tmp.mp4');
  const firstBytes = mediaBytes(11);
  writeFileSync(firstCandidate, firstBytes);
  const bootstrap = createRealMediaBootstrapForTest({ cacheRoot });
  const first = bootstrap.publishCandidate({ file: firstCandidate, probe: semanticProbe() });
  const receiptPath = join(cacheRoot, 'receipt.json');
  const receiptBefore = readFileSync(receiptPath);
  const payloadBefore = readFileSync(first);

  const secondCandidate = join(cacheRoot, '.second.tmp.mp4');
  const secondBytes = mediaBytes(29);
  const secondName = `${REAL_VIDEO.id}-${digest(secondBytes)}.mp4`;
  writeFileSync(secondCandidate, secondBytes);
  assert.throws(
    () => bootstrap.publishCandidate({
      file: secondCandidate,
      probe: semanticProbe(),
      fault: () => { throw new Error('simulated interruption before receipt commit'); },
    }),
    /simulated interruption/u,
  );

  assert.equal(cachedRealVideo(cacheRoot), first);
  assert.deepEqual(readFileSync(receiptPath), receiptBefore);
  assert.deepEqual(readFileSync(first), payloadBefore);
  assert.equal(existsSync(join(cacheRoot, secondName)), false);
  assert.deepEqual(readdirSync(cacheRoot).sort(), [first.split(/[\\/]/u).at(-1), 'receipt.json'].sort());
});

test('stale authority performs no rollback mutation after payload publication', (context) => {
  const { cacheRoot } = withAssetRoot(context);
  mkdirSync(cacheRoot, { recursive: true });
  let live = true;
  const bootstrap = createRealMediaBootstrapForTest({
    cacheRoot,
    assertStillLive: () => {
      if (!live) throw new Error('simulated stale authority');
      return cacheRoot;
    },
  });
  const firstCandidate = join(cacheRoot, '.first.tmp.mp4');
  writeFileSync(firstCandidate, mediaBytes(81));
  const first = bootstrap.publishCandidate({ file: firstCandidate, probe: semanticProbe() });
  const receiptBefore = readFileSync(join(cacheRoot, 'receipt.json'));
  const secondBytes = mediaBytes(82);
  const second = join(cacheRoot, `${REAL_VIDEO.id}-${digest(secondBytes)}.mp4`);
  const secondCandidate = join(cacheRoot, '.second.tmp.mp4');
  writeFileSync(secondCandidate, secondBytes);
  assert.throws(
    () => bootstrap.publishCandidate({
      file: secondCandidate,
      probe: semanticProbe(),
      fault: () => { live = false; },
    }),
    /stale authority/u,
  );
  assert.deepEqual(readFileSync(join(cacheRoot, 'receipt.json')), receiptBefore);
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), true, 'unreceipted orphan must remain for the next live owner');
});

test('a corrupt receipt is repaired through semantic acquisition instead of blocking it', (context) => {
  const { cacheRoot } = withAssetRoot(context);
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(join(cacheRoot, 'receipt.json'), '{not-json\n');
  const resolved = createRealMediaBootstrapForTest({
    cacheRoot,
    ...acquisitionDouble({ byte: 41 }),
  }).ensure();
  assert.equal(cachedRealVideo(cacheRoot), resolved);
  assert.equal(JSON.parse(readFileSync(join(cacheRoot, 'receipt.json'), 'utf8')).schemaVersion, 1);
});

test('acquisition refuses a provider response for any other observed video id', (context) => {
  const { cacheRoot } = withAssetRoot(context);
  const doubles = acquisitionDouble();
  assert.throws(
    () => createRealMediaBootstrapForTest({
      cacheRoot,
      resolveTool: doubles.resolveTool,
      execute: (executable, args) => {
        const result = doubles.execute(executable, args);
        if (executable === 'yt-dlp-yt-dlp.exe') {
          return result.replace(REAL_VIDEO.id, 'substituted-id');
        }
        return result;
      },
    }).ensure(),
    /different provider identity/u,
  );
  assert.equal(cachedRealVideo(cacheRoot), null);
  assert.deepEqual(readdirSync(cacheRoot), []);
});

test('receipt identity, provenance, path and payload mismatches are never selectable', (context) => {
  const { assetRoot } = withAssetRoot(context);
  const cases = [
    ['schema', (receipt) => { receipt.schemaVersion = 2; }],
    ['video id', (receipt) => { receipt.videoId = 'another-video'; }],
    ['URL', (receipt) => { receipt.url = 'https://example.invalid/substitute'; }],
    ['path traversal', (receipt) => { receipt.file = '../outside.mp4'; }],
    ['hash', (receipt) => { receipt.sha256 = '0'.repeat(64); }],
    ['size', (receipt) => { receipt.sizeBytes += 1; }],
    ['missing payload', (receipt, payload) => { rmSync(payload); }],
  ];
  for (const [label, mutate] of cases) {
    const cacheRoot = join(assetRoot, label.replaceAll(' ', '-'));
    mkdirSync(cacheRoot);
    const candidate = join(cacheRoot, '.candidate.tmp.mp4');
    writeFileSync(candidate, mediaBytes(53));
    const payload = createRealMediaBootstrapForTest({ cacheRoot }).publishCandidate({
      file: candidate, probe: semanticProbe(),
    });
    const receiptPath = join(cacheRoot, 'receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    mutate(receipt, payload);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.equal(cachedRealVideo(cacheRoot), null, `${label} mismatch was selected`);
  }
});

test('a multiply-linked payload is refused even when its bytes and receipt still match', (context) => {
  const { assetRoot, cacheRoot } = withAssetRoot(context);
  mkdirSync(cacheRoot);
  const candidate = join(cacheRoot, '.candidate.tmp.mp4');
  writeFileSync(candidate, mediaBytes(61));
  const payload = createRealMediaBootstrapForTest({ cacheRoot }).publishCandidate({
    file: candidate, probe: semanticProbe(),
  });
  linkSync(payload, join(assetRoot, 'second-link.mp4'));
  assert.equal(cachedRealVideo(cacheRoot), null);
});

test('an interrupted first installation leaves no receipt or selectable partial payload', (context) => {
  const { cacheRoot } = withAssetRoot(context);
  mkdirSync(cacheRoot);
  const candidate = join(cacheRoot, '.candidate.tmp.mp4');
  writeFileSync(candidate, mediaBytes(71));
  assert.throws(
    () => createRealMediaBootstrapForTest({ cacheRoot }).publishCandidate({
      file: candidate,
      probe: semanticProbe(),
      fault: () => { throw new Error('simulated first-install interruption'); },
    }),
    /first-install interruption/u,
  );
  assert.equal(cachedRealVideo(cacheRoot), null);
  assert.deepEqual(readdirSync(cacheRoot), []);
});

test('a redirected cache child is rejected before tool resolution or any download', (context) => {
  const { assetRoot, cacheRoot } = withAssetRoot(context);
  const redirected = join(assetRoot, 'redirected-target');
  mkdirSync(redirected);
  symlinkSync(redirected, cacheRoot, 'junction');
  let resolveCalls = 0;
  assert.throws(
    () => createRealMediaBootstrapForTest({
      cacheRoot,
      resolveTool: () => { resolveCalls += 1; },
      execute: () => assert.fail('a redirected cache must not start a download'),
    }).ensure(),
    /ordinary directory|redirected path/u,
  );
  assert.equal(resolveCalls, 0);
  assert.deepEqual(readdirSync(redirected), []);
});

test('an injected authority cannot authorize the real manager-owned cache', () => {
  assert.throws(
    () => ensureRealVideo({
      applicationLease: {},
      assertLease: () => assert.fail('managed-cache authority must not be injectable'),
      resolveTool: () => assert.fail('authority refusal must precede native-tool resolution'),
    }),
    /does not own the managed E2E asset lane/u,
  );
});

test('semantic probing rejects containers without both playable video and audio', () => {
  assert.throws(
    () => verifyRealVideoProbe({
      format: probeResult.format,
      streams: [probeResult.streams[0]],
    }),
    /semantic probe/u,
  );
  assert.throws(
    () => verifyRealVideoProbe({
      format: { duration: '600', format_name: 'mp4' },
      streams: probeResult.streams,
    }),
    /semantic probe/u,
  );
});
