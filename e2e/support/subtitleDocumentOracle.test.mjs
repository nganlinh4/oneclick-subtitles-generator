import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers';
import test from 'node:test';

import {
  snapshotOutputDirectory,
  verifySubtitleDocumentExport,
  waitForNewDocumentExport,
  waitForNewDocumentExports,
} from './subtitleDocumentOracle.js';

const EXPECTED = Object.freeze([
  Object.freeze({ ordinal: 1, startMs: 125, endMs: 1_875, text: 'Alpha\nsecond line' }),
  Object.freeze({ ordinal: 2, startMs: 2_500, endMs: 4_004, text: 'Việt 한글 🙂' }),
]);

const withRoot = async (operation) => {
  const root = mkdtempSync(join(tmpdir(), 'osg-document-oracle-'));
  mkdirSync(join(root, 'output'));
  try {
    await operation(join(root, 'output'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('independently parses exact SRT, JSON, and timing-free TXT exports', async () => withRoot(
  async (output) => {
    const srt = join(output, 'customer.srt');
    const json = join(output, 'customer.json');
    const txt = join(output, 'customer.txt');
    writeFileSync(srt, '1\n00:00:00,125 --> 00:00:01,875\nAlpha\nsecond line\n\n'
      + '2\n00:00:02,500 --> 00:00:04,004\nViệt 한글 🙂');
    writeFileSync(json, JSON.stringify([
      {
        id: 1, start: 0.125, end: 1.875,
        startTime: '00:00:00,125', endTime: '00:00:01,875', text: 'Alpha\nsecond line',
      },
      {
        id: 2, start: 2.5, end: 4.004,
        startTime: '00:00:02,500', endTime: '00:00:04,004', text: 'Việt 한글 🙂',
      },
    ]));
    writeFileSync(txt, 'Alpha\nsecond line\nViệt 한글 🙂');

    for (const [path, format] of [[srt, 'srt'], [json, 'json'], [txt, 'txt']]) {
      const result = verifySubtitleDocumentExport({ path, format, expected: EXPECTED });
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
      assert.equal(result.cueCount, 2);
    }
  },
));

test('refuses timing drift, inconsistent JSON timing fields, and timing in TXT', async () => withRoot(
  async (output) => {
    const srt = join(output, 'drift.srt');
    writeFileSync(srt, '1\n00:00:00,126 --> 00:00:01,875\nAlpha\nsecond line\n\n'
      + '2\n00:00:02,500 --> 00:00:04,004\nViệt 한글 🙂');
    assert.throws(
      () => verifySubtitleDocumentExport({ path: srt, format: 'srt', expected: EXPECTED }),
      /changed cue content or timing/,
    );

    const json = join(output, 'inconsistent.json');
    writeFileSync(json, JSON.stringify([
      {
        id: 1, start: 0.125, end: 1.875,
        startTime: '00:00:00,124', endTime: '00:00:01,875', text: 'Alpha\nsecond line',
      },
      {
        id: 2, start: 2.5, end: 4.004,
        startTime: '00:00:02,500', endTime: '00:00:04,004', text: 'Việt 한글 🙂',
      },
    ]));
    assert.throws(
      () => verifySubtitleDocumentExport({ path: json, format: 'json', expected: EXPECTED }),
      /inconsistent start fields/,
    );

    const txt = join(output, 'timed.txt');
    writeFileSync(txt, '00:00:00,125 --> 00:00:01,875\nAlpha');
    assert.throws(
      () => verifySubtitleDocumentExport({ path: txt, format: 'txt', expected: EXPECTED }),
    );
  },
));

test('refuses malformed UTF-8 and unexpected JSON fields', async () => withRoot(async (output) => {
  const malformed = join(output, 'malformed.txt');
  writeFileSync(malformed, Buffer.from([0xc3, 0x28]));
  assert.throws(
    () => verifySubtitleDocumentExport({ path: malformed, format: 'txt', expected: EXPECTED }),
    /not well-formed UTF-8/,
  );

  const json = join(output, 'extra.json');
  writeFileSync(json, JSON.stringify([{
    id: 1, start: 0.125, end: 1.875,
    startTime: '00:00:00,125', endTime: '00:00:01,875', text: 'Alpha\nsecond line', extra: true,
  }]));
  assert.throws(
    () => verifySubtitleDocumentExport({ path: json, format: 'json', expected: EXPECTED.slice(0, 1) }),
    /unexpected schema/,
  );
}));

test('waits for exactly one stable product output and rejects a zero-file proof', async () => withRoot(
  async (output) => {
    let before = snapshotOutputDirectory(output);
    setTimeout(() => writeFileSync(join(output, 'roundtrip.srt'), 'document bytes'), 20);
    assert.equal(
      await waitForNewDocumentExport({
        directory: output, before, format: 'srt', timeoutMs: 1_000, intervalMs: 20,
      }),
      join(output, 'roundtrip.srt'),
    );

    before = snapshotOutputDirectory(output);
    await assert.rejects(
      waitForNewDocumentExport({
        directory: output, before, format: 'json', timeoutMs: 40, intervalMs: 10,
      }),
      /no stable \.json document/,
    );
  },
));

test('refuses an unexpected extension or multiple files from one save action', async () => {
  await withRoot(async (output) => {
    const before = snapshotOutputDirectory(output);
    writeFileSync(join(output, 'wrong.txt'), 'wrong format');
    await assert.rejects(
      waitForNewDocumentExport({
        directory: output, before, format: 'srt', timeoutMs: 100, intervalMs: 10,
      }),
      /wrong format/,
    );
  });

  await withRoot(async (output) => {
    const before = snapshotOutputDirectory(output);
    writeFileSync(join(output, 'first.json'), '{}');
    writeFileSync(join(output, 'second.json'), '{}');
    await assert.rejects(
      waitForNewDocumentExport({
        directory: output, before, format: 'json', timeoutMs: 100, intervalMs: 10,
      }),
      /multiple outputs/,
    );
  });
});

test('waits for exactly N stable outputs from one bulk save action, sorted by name', async () => withRoot(
  async (output) => {
    const before = snapshotOutputDirectory(output);
    setTimeout(() => {
      writeFileSync(join(output, 'b-second.json'), 'bulk two');
      writeFileSync(join(output, 'a-first.srt'), 'bulk one');
    }, 20);
    assert.deepEqual(
      await waitForNewDocumentExports({
        directory: output, before, count: 2, timeoutMs: 1_000, intervalMs: 20,
      }),
      [join(output, 'a-first.srt'), join(output, 'b-second.json')],
    );
  },
));

test('a bulk wait rejects a short-lived third file and never settles on the wrong count', async () => withRoot(
  async (output) => {
    const before = snapshotOutputDirectory(output);
    writeFileSync(join(output, 'only-one.srt'), 'not enough yet');
    await assert.rejects(
      waitForNewDocumentExports({
        directory: output, before, count: 2, timeoutMs: 60, intervalMs: 10,
      }),
      /2 stable documents never appeared/,
    );

    const overshootBefore = snapshotOutputDirectory(output);
    writeFileSync(join(output, 'extra-one.srt'), 'x');
    writeFileSync(join(output, 'extra-two.srt'), 'y');
    writeFileSync(join(output, 'extra-three.srt'), 'z');
    await assert.rejects(
      waitForNewDocumentExports({
        directory: output, before: overshootBefore, count: 2, timeoutMs: 60, intervalMs: 10,
      }),
      /created more outputs than expected/,
    );
  },
));
