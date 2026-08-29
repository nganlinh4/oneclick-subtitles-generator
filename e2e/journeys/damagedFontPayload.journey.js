// What the application does when the font bytes it ships are damaged.
//
// Run by `e2e/scenarios/damagedFontPayload.mjs`, which stages a copy of the installation, breaks one
// shipped resource, and points the harness at it. Not part of the default journey glob: it is
// meaningless against an undamaged build, and running it there would assert nothing.
//
// THE GUARANTEE, NOT THE OUTCOME. With a network reachable, the delivery fallback replaces the
// damaged bytes and the font becomes ready; without one it cannot, and the application must refuse
// with a cause a person can act on. Both are correct behaviour. What is never correct is a capability
// that stays "resolving" forever, because that is the shape that made the editor wait for a preview
// that was never coming — so that is what is asserted, and it holds either way.

/* global browser, console, describe, document, it, window */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

import { captureWorkflowStep } from '../support/workflowEvidence.js';

const SETTLE_TIMEOUT_MS = 120_000;

const RESOLVED_STATES = new Set(['ready', 'refused']);

const verifiedRepairCopies = ({ root, expected }) => {
  const matches = [];
  let visited = 0;
  const visit = (directory) => {
    if (visited > 10_000) throw new Error('font repair diagnostic exceeded its file bound');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      const path = join(directory, entry.name);
      let status;
      try {
        status = lstatSync(path);
      } catch {
        continue;
      }
      if (entry.isSymbolicLink() || status.isSymbolicLink()) continue;
      if (entry.isDirectory() && status.isDirectory()) {
        if (resolve(realpathSync.native(path)) === resolve(path)) visit(path);
      } else if (entry.isFile() && status.isFile() && status.size === expected.size) {
        try {
          const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
          if (sha256 === expected.sha256) {
            matches.push(relative(root, path).replaceAll('\\', '/'));
          }
        } catch {
          // WebView and SQLite files can be transiently locked. They cannot match a font-source
          // digest, so an unreadable unrelated file is not evidence either way.
        }
      }
    }
  };
  visit(root);
  return matches.slice(0, 8);
};

const fontDiagnosticEvents = (root) => {
  const log = join(root, 'logs', 'osg.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split(/\r?\n/u).filter((line) => (
    line.includes('ui-font.ready')
    || line.includes('ui-font.unavailable')
    || line.includes('ui-font.deferred')
  )).slice(-8);
};

const observe = () => browser.execute(() => ({
  rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
  readiness: window.__OSG_FONT_READINESS__ ?? null,
}));

describe('an installation whose shipped font bytes are damaged', () => {
  it('still starts, and settles on a state a person can act on', async () => {
    const derivative = JSON.parse(process.env.OSG_E2E_APPLICATION_DERIVATIVE ?? 'null');
    assert.equal(derivative?.kind, 'staged-damage');
    assert.ok(Array.isArray(derivative.files) && derivative.files.length > 0);
    assert.ok(['changed', 'deleted'].includes(derivative.delta?.change));
    assert.ok(derivative.delta.path.startsWith('ui-fonts/'));
    assert.match(derivative.treeSha256, /^[0-9a-f]{64}$/u);
    let seen = await observe();

    try {
      await browser.waitUntil(async () => {
        seen = await observe();
        return seen.rootChildren > 0 && RESOLVED_STATES.has(seen.readiness?.state);
      }, {
        timeout: SETTLE_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: 'the font capability never settled; it must not wait forever',
      });
    } catch (error) {
      throw new Error(
        'the font capability never settled; it must not wait forever. last: '
          + JSON.stringify(seen, null, 2),
        { cause: error },
      );
    }

    console.log('damaged-payload observation:\n' + JSON.stringify(seen, null, 2));

    assert.ok(seen.rootChildren > 0, 'the editor must still render with a damaged font payload');
    assert.equal(seen.readiness.schema, 1);

    const runRoot = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(runRoot && resolve(runRoot) === resolve(realpathSync.native(runRoot)));
    const recoveredCopies = verifiedRepairCopies({
      root: runRoot,
      expected: derivative.delta.base,
    });
    const diagnosticEvents = fontDiagnosticEvents(runRoot);

    if (seen.readiness.state === 'ready') {
      // The delivery fallback repaired it. That is the designed behaviour for a damaged bundle: it
      // costs a download rather than the feature.
      assert.ok(seen.readiness.version, 'a ready record names the verified version');
      assert.equal(seen.readiness.reason, null);
      assert.ok(
        recoveredCopies.length > 0,
        'ready must be backed by a verified replacement for the exact damaged bundled source',
      );
      assert.ok(
        diagnosticEvents.some((line) => line.includes('ui-font.ready')),
        'ready must have a native ui-font.ready diagnostic',
      );
    } else {
      // No usable source. The refusal has to be actionable rather than decorative.
      assert.ok(seen.readiness.reason, 'a refusal must carry a typed cause');
      assert.equal(typeof seen.readiness.reason, 'string');
      assert.ok(
        !seen.readiness.reason.includes('/') && !seen.readiness.reason.includes(':'),
        `the cause must be a bounded token, not a path or a message: ${seen.readiness.reason}`,
      );
      assert.equal(typeof seen.readiness.retryable, 'boolean');
      assert.ok(
        diagnosticEvents.some((line) => (
          line.includes('ui-font.unavailable') || line.includes('ui-font.deferred')
        )),
        'refusal must have a native font repair diagnostic',
      );
    }
    assert.ok(seen.readiness.epoch > 0, 'the initial resolving record must have been superseded');

    await captureWorkflowStep({
      workflow: process.env.OSG_E2E_WORKFLOW,
      step: 'damaged-font-settled',
      description: 'The exact damaged font source settled through verified repair or typed refusal.',
      details: {
        damage: { change: derivative.delta.change, path: derivative.delta.path },
        readiness: seen.readiness,
        recoveredCopies,
        diagnosticEventCount: diagnosticEvents.length,
      },
    });
  });
});
