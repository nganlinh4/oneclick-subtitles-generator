// A customer builds and restructures a subtitle track through the real editor controls.
//
// editPersistRelaunch already proves that one text edit survives a second process, and
// timelineBoundary already proves Ctrl+A/Delete across the entire media domain. This journey owns
// the remaining document-editing contract: empty-state creation, row insertion/deletion/merge,
// pointer-range split, structural undo/redo, saved-state reset and session checkpoints. Every
// settled claim is checked against the application's SQLite database as well as the visible rows.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import {
  FIRST_CUE,
  importSubtitles,
  openProjectWithMedia,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'editor-cue-crud-and-history';
const SECOND_CUE = 'Second cue, plain text only';
const LAST_CUE = 'Last cue before the end';
const MANUAL_CUE = 'A manually created subtitle';
const LONG_EDIT = 'one two three four five six seven eight nine ten eleven twelve';
const EDITED_EXISTING_CUE = 'An existing cue edited inline';
const MERGED_CUE = `${FIRST_CUE} ${LONG_EDIT}`;
const LATER_SAVED_EDIT = 'A later saved checkpoint';
const RESET_TRANSIENT = 'This unsaved edit must be reset';
const CHECKPOINT_TRANSIENT = 'This edit must return to the latest checkpoint';

/* global $, browser, console, describe, document, it, window */

const visibleCueTexts = () => browser.execute(() => (
  [...document.querySelectorAll('.lyric-item[data-lyric-index]')]
    .sort((left, right) => (
      Number(left.getAttribute('data-lyric-index')) - Number(right.getAttribute('data-lyric-index'))
    ))
    .map((row) => (row.querySelector('.lyric-text')?.innerText ?? '').trim())
));

const installBoundedErrorWitness = () => browser.execute(() => {
  window.__OSG_EDITOR_CRUD_ERRORS__ = [];
  const argumentShape = (value, depth = 0, seen = new WeakSet()) => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    const primitive = typeof value;
    if (primitive !== 'object') return primitive;
    if (value instanceof ArrayBuffer) return 'ArrayBuffer';
    if (ArrayBuffer.isView(value)) return value.constructor?.name ?? 'ArrayBufferView';
    if (seen.has(value)) return 'circular';
    if (depth >= 4) return Array.isArray(value) ? 'array' : 'object';

    seen.add(value);
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < Math.min(value.length, 4); index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        items.push(descriptor && Object.hasOwn(descriptor, 'value')
          ? argumentShape(descriptor.value, depth + 1, seen)
          : 'accessor');
      }
      return { type: 'array', items, truncated: value.length > items.length };
    }

    const shape = {};
    const keys = Object.keys(value).sort().slice(0, 32);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      shape[key] = descriptor && Object.hasOwn(descriptor, 'value')
        ? argumentShape(descriptor.value, depth + 1, seen)
        : 'accessor';
    }
    if (Object.keys(value).length > keys.length) shape.__truncated__ = 'boolean';
    return shape;
  };
  const describe = (value) => {
    if (value instanceof Error || (value && typeof value === 'object')) {
      return {
        name: String(value.name ?? '').slice(0, 80),
        code: String(value.code ?? '').slice(0, 120),
        message: String(value.message ?? value).slice(0, 500),
        stack: typeof value.stack === 'string' ? value.stack.slice(0, 1_500) : null,
        cause: value.cause && typeof value.cause === 'object' ? {
          name: String(value.cause.name ?? '').slice(0, 80),
          code: String(value.cause.code ?? '').slice(0, 120),
          message: String(value.cause.message ?? value.cause).slice(0, 500),
          stack: typeof value.cause.stack === 'string' ? value.cause.stack.slice(0, 1_000) : null,
        } : null,
        authoritativeRows: Array.isArray(value.authoritativeRows)
          ? value.authoritativeRows.slice(0, 8).map((row) => ({
            text: String(row?.text ?? '').slice(0, 200),
            start: row?.start,
            end: row?.end,
          }))
          : null,
      };
    }
    return String(value).slice(0, 500);
  };
  const push = (kind, values) => {
    const target = window.__OSG_EDITOR_CRUD_ERRORS__;
    if (target.length < 50) target.push({ kind, values: values.map(describe) });
  };
  const pushInvokeRejection = (command, args, error) => {
    const target = window.__OSG_EDITOR_CRUD_ERRORS__;
    if (target.length >= 50) return;
    target.push({
      kind: 'ipc.rejection',
      command: typeof command === 'string' ? command.slice(0, 160) : '<non-string-command>',
      args: argumentShape(args),
      error: describe(error),
    });
  };

  const internals = window.__TAURI_INTERNALS__;
  if (typeof internals?.invoke === 'function' && !window.__OSG_EDITOR_CRUD_INVOKE_WITNESS__) {
    const originalInvoke = internals.invoke;
    internals.invoke = function witnessedInvoke(command, args, options) {
      let result;
      try {
        result = Reflect.apply(originalInvoke, this, [command, args, options]);
      } catch (error) {
        pushInvokeRejection(command, args, error);
        throw error;
      }
      return Promise.resolve(result).catch((error) => {
        pushInvokeRejection(command, args, error);
        throw error;
      });
    };
    window.__OSG_EDITOR_CRUD_INVOKE_WITNESS__ = true;
  }

  const originalError = console.error.bind(console);
  console.error = (...values) => {
    push('console.error', values);
    originalError(...values);
  };
  window.addEventListener('error', (event) => push('error', [event.error ?? event.message]));
  window.addEventListener('unhandledrejection', (event) => push('rejection', [event.reason]));
});

const boundedErrorWitness = () => browser.execute(() => (
  window.__OSG_EDITOR_CRUD_ERRORS__ ?? []
));

const waitForVisibleCues = async (expected, message) => {
  let actual = [];
  try {
    await browser.waitUntil(async () => {
      actual = await visibleCueTexts();
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: message,
    });
  } catch (error) {
    throw new Error(
      `${message}. visible rows: ${JSON.stringify(actual)}`,
      { cause: error },
    );
  }
};

const waitForDurableCues = async (root, expected, message) => {
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = durableState(root);
      return JSON.stringify(state.cues.map((cue) => cue.text)) === JSON.stringify(expected);
    }, {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: message,
    });
  } catch (error) {
    throw new Error(
      `${message}. durable rows: ${JSON.stringify(state?.cues?.map((cue) => cue.text) ?? [])}; `
      + `browser witness: ${JSON.stringify(await boundedErrorWitness())}`,
      { cause: error },
    );
  }
  return state;
};

const editCueAt = async (index, replacement) => {
  await clickControl(`.lyric-item[data-lyric-index="${index}"] .edit-lyric-btn`);
  const input = await $('.lyric-text-input');
  await input.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: `cue ${index + 1} did not expose its inline editor`,
  });
  await input.click();
  await input.setValue(replacement);
  await browser.keys('Enter');
  await browser.waitUntil(async () => {
    const rows = await visibleCueTexts();
    return rows[index] === replacement && !(await input.isExisting());
  }, {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: `cue ${index + 1} did not commit ${JSON.stringify(replacement)}`,
  });
};

const activateDirectionalControl = async (index, container, direction) => {
  const rowSelector = `.lyric-item[data-lyric-index="${index}"]`;
  const hostSelector = `${rowSelector} ${container}`;
  const controlSelector = `${hostSelector} .arrow-button.${direction}`;
  // The shipped UI intentionally keeps `.lyric-controls` at opacity:0 until the customer hovers
  // the row. An off-screen WebView has no interactive-desktop cursor hit-test, so WebDriver pointer
  // movement cannot establish CSS `:hover` even though the same coordinates work in an interactive
  // window. Dispatch the public mouse-over boundary inside the document; React still owns the state
  // transition and the real button still owns the edit. No component state or native command is
  // called directly.
  const row = await $(rowSelector);
  await row.waitForDisplayed({ timeout: 30_000 });
  const hovered = await browser.execute((rowTarget, hostTarget) => {
    const rowNode = document.querySelector(rowTarget);
    const hostNode = document.querySelector(hostTarget);
    if (rowNode === null || hostNode === null) return false;
    rowNode.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    for (const node of [rowNode, hostNode]) {
      node.dispatchEvent(new window.MouseEvent('mouseover', {
        bubbles: true, cancelable: true, composed: true, view: window,
      }));
    }
    return true;
  }, rowSelector, hostSelector);
  assert.equal(hovered, true, `${hostSelector} disappeared before its hover boundary`);
  await browser.waitUntil(async () => browser.execute((target) => {
    const node = document.querySelector(target);
    return node !== null && node.disabled !== true;
  }, controlSelector), {
    timeout: 30_000,
    interval: 50,
    timeoutMsg: `${container} ${direction} did not render enabled for cue ${index + 1}`,
  });
  const clicked = await browser.execute((target) => {
    const node = document.querySelector(target);
    if (!(node instanceof window.HTMLButtonElement) || node.disabled) return false;
    node.click();
    return true;
  }, controlSelector);
  assert.equal(clicked, true, `${controlSelector} disappeared before activation`);
};

const insertBelow = async (index) => {
  await activateDirectionalControl(
    index,
    '.insert-lyric-button-container',
    'down',
  );
};

const mergeBelow = async (index) => {
  await activateDirectionalControl(
    index,
    '.merge-lyrics-button-container',
    'down',
  );
};

const waitForHistoryControl = async (selector, enabled) => {
  const control = await $(selector);
  await control.waitForExist({ timeout: 30_000 });
  await browser.waitUntil(async () => (await control.isEnabled()) === enabled, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: `${selector} did not become ${enabled ? 'enabled' : 'disabled'}`,
  });
};

const undoTo = async (root, expected, message) => {
  await waitForHistoryControl('.undo-btn', true);
  await clickControl('.undo-btn');
  await waitForVisibleCues(expected, message);
  await waitForDurableCues(root, expected, `${message} in SQLite`);
};

const redoTo = async (root, expected, message) => {
  await waitForHistoryControl('.redo-btn', true);
  await clickControl('.redo-btn');
  await waitForVisibleCues(expected, message);
  await waitForDurableCues(root, expected, `${message} in SQLite`);
};

const selectFirstHalfOfTimeline = async () => {
  const timeline = await $('.subtitle-timeline');
  await timeline.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: 'the subtitle timeline never became available for pointer selection',
  });
  const { width } = await timeline.getSize();
  assert.ok(width >= 100, `the subtitle timeline is too narrow to select: ${width}px`);

  // Element-origin pointer offsets are relative to its centre. Starting just inside the left edge and
  // ending at 48% selects the merged 0.5-7.0s cue on the real 19s fixture without relying on a
  // private React range setter.
  const left = -Math.floor(width / 2) + 4;
  const end = -Math.floor(width / 2) + Math.floor(width * 0.48);
  await browser.action('pointer')
    .move({ origin: timeline, x: left, y: 0 })
    .down({ button: 0 })
    .pause(100)
    .move({ origin: timeline, x: end, y: 0, duration: 450 })
    .up({ button: 0 })
    .perform();

  const actionBar = await $('.range-action-bar');
  await actionBar.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: 'pointer selection did not expose the selected-range actions',
  });
  await waitForHistoryControl('[data-osg-action="split-subtitles"]', true);
};

const saveAndWaitForCheckpoint = async (root, expected) => {
  await waitForHistoryControl('.lyrics-save-btn', true);
  await clickControl('.lyrics-save-btn');
  await waitForHistoryControl('.lyrics-save-btn', false);
  await waitForHistoryControl('.checkpoint-btn', true);
  // The enabled checkpoint button may predate a second save. The disabled Save state and one event
  // turn together guarantee React committed both setSavedLyrics and createCheckpoint from the same
  // successful callback before the journey continues.
  await browser.pause(250);
  return waitForDurableCues(root, expected, 'the saved editor state never reached SQLite');
};

describe('customer subtitle cue CRUD and history', () => {
  it('creates, restructures, saves, resets and revisits real editor checkpoints', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run against an isolated data root');

    await openProjectWithMedia();
    await installBoundedErrorWitness();
    await importSubtitles();
    const imported = [FIRST_CUE, SECOND_CUE, LAST_CUE];
    await waitForVisibleCues(imported, 'the imported baseline did not settle');
    const initial = await waitForDurableCues(root, imported, 'the imported baseline was not durable');
    assert.equal(initial.counts.projects, 1, 'editing must belong to exactly one project');
    assert.equal(initial.counts.media, 1, 'editing must retain exactly one media asset');

    // Empty-state creation is a distinct control from row insertion. Reach it through the row delete
    // buttons, not Ctrl+A: the latter is already owned by timelineBoundary.
    for (let remaining = imported.length; remaining > 0; remaining -= 1) {
      await clickControl(`.lyric-item[data-lyric-index="${remaining - 1}"] .delete-lyric-btn`);
      await waitForVisibleCues(imported.slice(0, remaining - 1), 'row deletion did not settle');
    }
    await clickControl('.empty-insert-lyric-btn');
    await waitForVisibleCues([''], 'the empty-state create control did not add a cue');
    await browser.execute(() => { window.__OSG_EDITOR_CRUD_ERRORS__ = []; });
    await editCueAt(0, MANUAL_CUE);
    await waitForDurableCues(root, [MANUAL_CUE], 'the manually created cue was not durable');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-manual-empty-state-cue',
      description: 'After deleting individual rows, the empty editor creates and edits a real durable cue.',
      details: { cueText: MANUAL_CUE },
      focusSelector: '.lyrics-container-wrapper',
    });

    // Walk the structural history back to the imported baseline, then take one real redo and undo it
    // again. This proves redo for a row deletion rather than repeating the text-only history proof.
    await undoTo(root, [''], 'undo did not restore the blank newly-created cue');
    await undoTo(root, [], 'undo did not remove the newly-created cue');
    await undoTo(root, [FIRST_CUE], 'undo did not restore the first deleted row');
    await undoTo(root, [FIRST_CUE, SECOND_CUE], 'undo did not restore the second deleted row');
    await undoTo(root, imported, 'undo did not restore the complete imported baseline');
    await redoTo(root, [FIRST_CUE, SECOND_CUE], 'redo did not replay the structural row deletion');
    await undoTo(root, imported, 'undo after redo did not recover the imported baseline');

    // Use the common first-row Add-below action. This deliberately proves ordering as well as cue
    // creation: the blank row must land between the first and second cues, never at the beginning.
    await insertBelow(0);
    await waitForVisibleCues(
      [FIRST_CUE, '', SECOND_CUE, LAST_CUE],
      'Add-below on the first row did not insert between the first and second cues',
    );
    await editCueAt(1, LONG_EDIT);
    await editCueAt(2, EDITED_EXISTING_CUE);
    const beforeMerge = [FIRST_CUE, LONG_EDIT, EDITED_EXISTING_CUE, LAST_CUE];
    await waitForDurableCues(root, beforeMerge, 'inserted and inline-edited cues were not durable');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-row-insert-and-inline-edit',
      description: 'The row insertion control creates timed content and inline editing commits it.',
      details: { insertedCue: LONG_EDIT, editedExistingCue: EDITED_EXISTING_CUE },
      focusSelector: '.lyrics-container-wrapper',
    });

    await mergeBelow(0);
    const merged = [MERGED_CUE, EDITED_EXISTING_CUE, LAST_CUE];
    await waitForVisibleCues(merged, 'merge-below did not combine the first two cues');
    await undoTo(root, beforeMerge, 'undo did not reverse the merge');
    await redoTo(root, merged, 'redo did not restore the merge');
    await waitForDurableCues(root, merged, 'the redone merge was not durable');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-merge-with-structural-history',
      description: 'Merge-below survives a structural undo and redo with one combined timing span.',
      details: { mergedCue: MERGED_CUE },
      focusSelector: '.lyrics-container-wrapper',
    });

    await clickControl('.lyric-item[data-lyric-index="1"] .delete-lyric-btn');
    const afterIndividualDelete = [MERGED_CUE, LAST_CUE];
    await waitForVisibleCues(afterIndividualDelete, 'individual delete did not remove the edited cue');
    await undoTo(root, merged, 'undo did not restore the individually deleted cue');
    await redoTo(root, afterIndividualDelete, 'redo did not remove the individually deleted cue again');

    // Select a real pointer range, open the real split dialog and accept its default eight-word
    // policy. The short final cue overlaps the range but remains unchanged; only the merged long cue
    // is split.
    await selectFirstHalfOfTimeline();
    await clickControl('[data-osg-action="split-subtitles"]');
    const apply = await $('.apply-btn');
    await apply.waitForClickable({ timeout: 30_000, timeoutMsg: 'the smart-split dialog did not open' });
    await apply.click();

    let splitRows = [];
    try {
      await browser.waitUntil(async () => {
        splitRows = await visibleCueTexts();
        return splitRows.length > afterIndividualDelete.length
          && splitRows.at(-1) === LAST_CUE
          && splitRows.slice(0, -1).join(' ') === MERGED_CUE;
      }, {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: 'the selected long cue was not split losslessly',
      });
    } catch (error) {
      throw new Error(
        `the selected long cue was not split losslessly: ${JSON.stringify(splitRows)}`,
        { cause: error },
      );
    }
    assert.ok(splitRows.length >= 3, 'smart split did not create more than one chunk');
    await undoTo(root, afterIndividualDelete, 'undo did not restore the unsplit merged cue');
    await redoTo(root, splitRows, 'redo did not restore the smart split');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-pointer-range-smart-split',
      description: 'Pointer range selection splits only the long cue and structural redo restores every word.',
      details: { chunks: splitRows.slice(0, -1), unchangedCue: LAST_CUE },
      focusSelector: '.lyrics-container-wrapper',
    });

    const firstCheckpoint = [...splitRows];
    let saved = await saveAndWaitForCheckpoint(root, firstCheckpoint);
    assert.ok(saved.latestRevision !== null, 'the first saved checkpoint has no native revision');

    const secondCheckpoint = [LATER_SAVED_EDIT, ...firstCheckpoint.slice(1)];
    await editCueAt(0, LATER_SAVED_EDIT);
    saved = await saveAndWaitForCheckpoint(root, secondCheckpoint);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-two-saved-checkpoints',
      description: 'Two distinct saved states are durable and available to the editor history controls.',
      details: { revision: saved.latestRevision?.revision ?? null, cueCount: saved.counts.cues },
      focusSelector: '.lyrics-container-wrapper',
    });

    await editCueAt(0, RESET_TRANSIENT);
    await waitForDurableCues(root, [RESET_TRANSIENT, ...secondCheckpoint.slice(1)], (
      'the transient edit did not enter native history before reset'
    ));
    await clickControl('.reset-btn');
    await waitForVisibleCues(secondCheckpoint, 'reset did not return to the most recently saved state');
    await waitForDurableCues(root, secondCheckpoint, 'reset did not restore the saved state in SQLite');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-reset-to-latest-save',
      description: 'Reset discards an unsaved edit and returns to the latest saved checkpoint.',
      details: { restoredFirstCue: LATER_SAVED_EDIT },
      focusSelector: '.lyrics-container-wrapper',
    });

    // First prove the second save created its own checkpoint: from a transient edit, Jump must return
    // to the latest saved value, not skip directly to the older save.
    await editCueAt(0, CHECKPOINT_TRANSIENT);
    await waitForHistoryControl('.checkpoint-btn', true);
    await clickControl('.checkpoint-btn');
    await waitForVisibleCues(
      secondCheckpoint,
      'jump-to-checkpoint skipped the latest saved checkpoint',
    );
    await waitForDurableCues(
      root,
      secondCheckpoint,
      'the latest checkpoint did not reconcile with SQLite',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-jump-to-latest-checkpoint',
      description: 'A transient edit jumps back to the latest of two independently saved checkpoints.',
      details: { restoredFirstCue: LATER_SAVED_EDIT },
      focusSelector: '.lyrics-container-wrapper',
    });

    // At the latest saved state, Jump must now skip that equal checkpoint and revisit the older one.
    // That is observably different from Reset and catches both an inert flag and a single-entry lie.
    await waitForHistoryControl('.checkpoint-btn', true);
    await clickControl('.checkpoint-btn');
    await waitForVisibleCues(firstCheckpoint, 'jump-to-checkpoint did not revisit the older save');
    const revisited = await waitForDurableCues(
      root,
      firstCheckpoint,
      'jump-to-checkpoint did not persist the older state',
    );
    assert.equal(revisited.counts.projects, 1, 'history navigation changed project ownership');
    assert.equal(revisited.counts.media, 1, 'history navigation changed media ownership');
    assert.ok(
      revisited.cues.every((cue, index) => cue.ordinal === index + 1),
      'history navigation left non-contiguous durable cue ordinals',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '08-jump-to-older-checkpoint',
      description: 'Jump-to-checkpoint revisits the older save while retaining the same project and media.',
      details: {
        projectId: revisited.projects[0].id,
        mediaId: revisited.media[0].id,
        revision: revisited.latestRevision?.revision ?? null,
        cueCount: revisited.counts.cues,
      },
      focusSelector: '.lyrics-container-wrapper',
    });

    // Finish at a clean saved state so later journeys never inherit a deliberately dirty document.
    await saveAndWaitForCheckpoint(root, firstCheckpoint);
  });
});
