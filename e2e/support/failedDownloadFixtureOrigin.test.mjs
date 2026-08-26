/* global fetch */

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  readDownloadFixtureEvents,
  startDownloadFixtureOrigin,
} from './downloadFixtureOrigin.js';

test('a failure route serves one real inspection request then deterministically rejects transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-failed-download-origin-test-'));
  const a = join(root, 'a.mp4');
  const c = join(root, 'c.mp4');
  writeFileSync(a, Buffer.alloc(8 * 1024, 0x41));
  writeFileSync(c, Buffer.alloc(8 * 1024, 0x43));
  let origin;
  try {
    origin = await startDownloadFixtureOrigin({
      eventsPath: join(root, 'events.jsonl'),
      sources: [
        { label: 'a', path: a },
        { label: 'c', path: c, rejectGetAfter: 1 },
      ],
      chunkBytes: 4 * 1024,
      chunkDelayMs: 1,
    });
    assert.deepEqual(origin.manifest.map(({ label }) => label), ['a', 'c']);
    assert.deepEqual(origin.manifest[1].failure,
      { kind: 'rejectGetAfter', after: 1, status: 503 });

    const inspection = await fetch(origin.manifest[1].url);
    assert.equal(inspection.status, 200);
    assert.equal((await inspection.arrayBuffer()).byteLength, 8 * 1024);
    const transfer = await fetch(origin.manifest[1].url);
    assert.equal(transfer.status, 503);
    assert.equal((await transfer.arrayBuffer()).byteLength, 0);

    const events = readDownloadFixtureEvents(origin.eventsPath);
    assert.equal(events.filter(({ route, event }) => route === 'c' && event === 'request-complete').length, 1);
    assert.deepEqual(
      events.filter(({ route, event }) => route === 'c' && event === 'request-rejected')
        .map(({ status }) => status),
      [503],
    );
    assert.equal(JSON.stringify(events).includes('token='), false,
      'the failure ledger leaked an exact URL capability');
  } finally {
    if (origin) await origin.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the failure boundary rejects unbounded and nonsensical request counts before binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-failed-download-boundary-test-'));
  const a = join(root, 'a.mp4');
  const c = join(root, 'c.mp4');
  writeFileSync(a, 'a');
  writeFileSync(c, 'c');
  try {
    for (const rejectGetAfter of [-1, 11, 0.5, '1']) {
      await assert.rejects(startDownloadFixtureOrigin({
        eventsPath: join(root, `events-${String(rejectGetAfter).replace('.', '-')}.jsonl`),
        sources: [
          { label: 'a', path: a },
          { label: 'c', path: c, rejectGetAfter },
        ],
      }), /invalid rejection boundary/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
