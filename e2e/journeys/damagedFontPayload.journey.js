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

import { strict as assert } from 'node:assert';

const SETTLE_TIMEOUT_MS = 120_000;

const RESOLVED_STATES = new Set(['ready', 'refused']);

const observe = () => browser.execute(() => ({
  rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
  readiness: window.__OSG_FONT_READINESS__ ?? null,
}));

describe('an installation whose shipped font bytes are damaged', () => {
  it('still starts, and settles on a state a person can act on', async () => {
    const derivative = JSON.parse(process.env.OSG_E2E_APPLICATION_DERIVATIVE ?? 'null');
    assert.equal(derivative?.kind, 'staged-damage');
    assert.equal(derivative.changedPaths.length + derivative.deletedPaths.length, 1);
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

    if (seen.readiness.state === 'ready') {
      // The delivery fallback repaired it. That is the designed behaviour for a damaged bundle: it
      // costs a download rather than the feature.
      assert.ok(seen.readiness.version, 'a ready record names the verified version');
      assert.equal(seen.readiness.reason, null);
      return;
    }

    // No usable source. The refusal has to be actionable rather than decorative.
    assert.ok(seen.readiness.reason, 'a refusal must carry a typed cause');
    assert.equal(typeof seen.readiness.reason, 'string');
    assert.ok(
      !seen.readiness.reason.includes('/') && !seen.readiness.reason.includes(':'),
      `the cause must be a bounded token, not a path or a message: ${seen.readiness.reason}`,
    );
    assert.equal(typeof seen.readiness.retryable, 'boolean');
    assert.ok(seen.readiness.epoch > 0, 'the initial resolving record must have been superseded');
  });
});
