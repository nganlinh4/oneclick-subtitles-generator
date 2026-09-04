/* global browser, clearTimeout, describe, document, it, setTimeout */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

import { clickControl, openEditor } from '../support/editor.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'prompt-dj-midi-input';
const HOST = resolve(
  import.meta.dirname,
  '..',
  'tools',
  'midi-virtual-host',
  'bin',
  'Release',
  'net10.0-windows10.0.26100.0',
  'win-x64',
  'midi-virtual-host.exe',
);

const startMidiHost = () => {
  const status = lstatSync(HOST);
  assert.ok(status.isFile() && !status.isSymbolicLink(), 'the reviewed MIDI host is unavailable');
  const process = spawn(HOST, [], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const records = [];
  const waiters = [];
  const diagnostics = [];
  let buffered = '';
  process.stdout.setEncoding('utf8');
  process.stdout.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/u);
    buffered = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const record = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(record);
      else records.push(record);
    }
  });
  process.stderr.setEncoding('utf8');
  process.stderr.on('data', (chunk) => {
    diagnostics.push(...chunk.split(/\r?\n/u).filter(Boolean));
    if (diagnostics.length > 20) diagnostics.splice(0, diagnostics.length - 20);
  });
  const nextRecord = (timeoutMs = 15_000) => {
    if (records.length > 0) return Promise.resolve(records.shift());
    return new Promise((resolveRecord, reject) => {
      const waiter = {
        resolve(record) {
          clearTimeout(timer);
          resolveRecord(record);
        },
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        const exit = process.exitCode === null ? 'running' : `exit ${process.exitCode}`;
        const detail = diagnostics.length > 0 ? diagnostics.join(' | ') : 'no diagnostics';
        reject(new Error(`the isolated MIDI host produced no bounded response (${exit}; ${detail})`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  return { process, nextRecord };
};

const promptDjMidiState = () => browser.execute(() => {
  const outer = document.querySelector('.music-generator-section iframe[title="promptdj-midi"]');
  const host = outer?.contentDocument?.querySelector('prompt-dj-midi');
  const controller = [...(host?.shadowRoot?.querySelectorAll('prompt-controller') ?? [])]
    .find((candidate) => candidate.promptId === 'prompt-0');
  const knob = controller?.shadowRoot?.querySelector('weight-knob');
  const dropdown = document.querySelector('.music-generator-section .midi-controls .custom-dropdown-button');
  return {
    ready: host !== null && host !== undefined,
    endpoint: dropdown?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
    activeInputId: host?.getActiveMidiInputId?.() ?? null,
    cc: Number(controller?.cc ?? -1),
    weight: Number(controller?.weight ?? -1),
    displayedWeight: Number(knob?.getAttribute('aria-valuenow') ?? -1),
  };
});

describe('a customer controls PromptDJ with a MIDI device', () => {
  it('discovers a real process-owned endpoint and maps its CC value to one prompt', async () => {
    const midi = startMidiHost();
    let midiEnabled = false;
    try {
      const ready = await midi.nextRecord();
      assert.equal(ready.ready, true, `the Windows MIDI diagnostics endpoint refused: ${ready.reason ?? 'unknown'}`);
      assert.equal(typeof ready.name, 'string');
      assert.ok(ready.name.length > 0 && ready.name.length <= 512, 'the MIDI endpoint name is invalid');
      await openEditor();
      const collapsed = await browser.execute(
        () => document.querySelector('.music-generator-section')?.classList.contains('collapsed') ?? null,
      );
      if (collapsed) await clickControl('.music-generator-section .collapse-button');
      await browser.waitUntil(async () => (await promptDjMidiState()).ready, {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: 'the embedded PromptDJ surface did not become reachable',
      });
      await clickControl('.music-generator-section .midi-controls md-switch');
      midiEnabled = true;
      await browser.waitUntil(async () => {
        const state = await promptDjMidiState();
        return state.endpoint.includes(ready.name) && typeof state.activeInputId === 'string';
      }, {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: 'PromptDJ did not enumerate the isolated Windows MIDI endpoint',
      });
      const before = await promptDjMidiState();
      assert.equal(before.cc, 0, 'prompt-0 no longer owns MIDI CC 0');
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-midi-endpoint-selected',
        description: 'PromptDJ enumerated and selected the process-owned Windows MIDI endpoint.',
        details: { endpoint: ready.name, promptId: 'prompt-0', cc: before.cc },
        focusSelector: '.music-generator-section',
      });

      midi.process.stdin.write('cc 0 0 127\n');
      assert.deepEqual(await midi.nextRecord(), {
        sent: true,
        channel: 0,
        controller: 0,
        value: 127,
      });
      await browser.waitUntil(async () => {
        const state = await promptDjMidiState();
        return Math.abs(state.weight - 2) < 0.0001
          && Math.abs(state.displayedWeight - 2) < 0.0001;
      }, {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: 'the real MIDI CC message did not update the PromptDJ prompt weight',
      });
      const after = await promptDjMidiState();
      assert.equal(
        await browser.execute(() => document.querySelectorAll('.toast-error, [role="alert"]').length),
        0,
        'the MIDI interaction left a visible failure',
      );
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-midi-cc-updated-prompt',
        description: 'A real CC 0 value of 127 moved prompt-0 to its exact maximum weight.',
        details: { beforeWeight: before.weight, afterWeight: after.weight, displayedWeight: after.displayedWeight },
        focusSelector: '.music-generator-section',
      });
      await clickControl('.music-generator-section .midi-controls md-switch');
      await browser.waitUntil(async () => (await promptDjMidiState()).activeInputId === null, {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: 'turning MIDI off did not close the selected browser input',
      });
      midiEnabled = false;
    } finally {
      if (midiEnabled) {
        try {
          await browser.execute(async () => {
            const outer = document.querySelector('.music-generator-section iframe[title="promptdj-midi"]');
            const host = outer?.contentDocument?.querySelector('prompt-dj-midi');
            await host?.setShowMidi?.(false);
          });
        } catch {
          // The browser session may already be closing. The bounded helper shutdown below will
          // expose any remaining ownership problem instead of silently abandoning the endpoint.
        }
      }
      if (midi.process.exitCode === null) {
        midi.process.stdin.write('quit\n');
        await Promise.race([
          new Promise((resolveExit) => midi.process.once('exit', resolveExit)),
          new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
        ]);
      }
      if (midi.process.exitCode === null) midi.process.kill();
    }
  });
});
