// The first journey: does the real application reach a usable UI?
//
// Deliberately the smallest possible real-binary assertion. Everything above it in the pyramid
// already passes — 1428 Rust tests, 2147 frontend tests, a green installed lifecycle smoke — while
// the product fails in use. So the first thing to establish is not a feature but a fact: that a
// WebDriver session can attach to the shipped binary and see the editor.
//
// The wait is on the editor actually rendering, not on `document.readyState`. A blank document
// reports `complete` too, and the first version of this test asserted at 164ms against exactly that
// — the application needs several seconds to reach `app.ready`.

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { waitForAutomationWindowIsolation } from '../support/editor.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global browser, console, describe, document, it */

const RENDER_TIMEOUT_MS = 90_000;

const inspect = () => browser.execute(() => ({
  href: document.location.href,
  readyState: document.readyState,
  hasRoot: document.querySelector('#root') !== null,
  rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
  bodyText: (document.body?.innerText || '').slice(0, 400),
  errorText: [...document.querySelectorAll('[role="alert"], [class*="error" i]')]
    .map((node) => node.innerText).filter(Boolean).slice(0, 5),
}));

describe('the application starts', () => {
  it('reaches a rendered editor', async () => {
    const windowRect = await waitForAutomationWindowIsolation();
    let last = await inspect();
    console.log('first observation:\n' + JSON.stringify(last, null, 2));

    try {
      await browser.waitUntil(async () => {
        last = await inspect();
        return last.rootChildren > 0;
      }, {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: 'the editor never rendered before its timeout',
      });
    } catch (error) {
      last = await inspect();
      throw new Error(`the editor never rendered. last observation: ${JSON.stringify(last)}`, {
        cause: error,
      });
    }

    console.log('rendered observation:\n' + JSON.stringify(last, null, 2));
    assert.ok(last.rootChildren > 0, 'the React root must have rendered');
    assert.deepEqual(last.errorText, [], 'no error surface may be visible at startup');

    const logRoot = join(process.env.OSG_E2E_DATA_ROOT, 'logs');
    let hiddenMarker = false;
    await browser.waitUntil(() => {
      if (!existsSync(logRoot)) return false;
      hiddenMarker = readdirSync(logRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
        .some((entry) => {
          try {
            return readFileSync(join(entry.parentPath, entry.name), 'utf8')
              .includes('automation.window_offscreen');
          } catch {
            // The append lock is transient on Windows. A locked candidate is not success, so the
            // bounded wait retries until the marker is readable or fails with the safety message.
            return false;
          }
        });
      return hiddenMarker;
    }, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the automation binary never recorded its permanent-hidden window branch',
    });

    await captureWorkflowStep({
      workflow: 'startup',
      step: '01-hidden-rendered-editor',
      description: 'The compiled real app rendered while its native window remained hidden and off-screen.',
      details: { hiddenMarker, windowRect },
    });
  });
});
