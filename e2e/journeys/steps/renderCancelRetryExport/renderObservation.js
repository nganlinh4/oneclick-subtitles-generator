// Read-only render observations for the cancel/retry/export journey: durable ledger, visible
// render errors, scratch entries and the stable customer export file.
/* global MutationObserver, browser, document, getComputedStyle, window */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { durableState } from '../../../support/database.js';
import { listMediaFiles } from '../../../support/nativeMediaOracle.js';

const MEDIA_EXTENSIONS = new Set(['.mkv', '.mov', '.mp4', '.webm']);
const MAX_RECORDED_RENDER_ERRORS = 32;

export const readableRenderLedger = (root) => {
  const state = durableState(root);
  return Object.freeze({
    projects: state.projects,
    jobs: state.jobs.filter(({ kind }) => kind === 'renderVideo'),
    artifacts: state.artifacts.filter(({ kind }) => kind === 'renderedVideo'),
  });
};

export const installTransientRenderErrorLedger = () => browser.execute((maximumEvents) => {
  window.__OSG_E2E_RENDER_ERROR_LEDGER__?.observer?.disconnect?.();
  const events = [];
  let overflow = 0;
  const selector = [
    '.video-rendering-section [role="alert"]',
    '.video-rendering-section .error',
    '.video-rendering-section .error-message',
    '.video-rendering-section .video-error',
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
  ].join(',');
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const record = (node, requireVisible) => {
    if (requireVisible && !visible(node)) return;
    const message = (node.innerText || node.textContent || '')
      .trim().replace(/\s+/g, ' ').slice(0, 400);
    if (!message || events.includes(message)) return;
    if (events.length >= maximumEvents) {
      overflow += 1;
      return;
    }
    events.push(message);
  };
  const inspect = (candidate, requireVisible) => {
    const node = candidate?.nodeType === 1 ? candidate : candidate?.parentElement;
    if (node === null || node === undefined) return;
    if (node.matches?.(selector)) record(node, requireVisible);
    for (const descendant of node.querySelectorAll?.(selector) ?? []) {
      record(descendant, requireVisible);
    }
  };
  const captureVisible = () => {
    for (const node of document.querySelectorAll(selector)) record(node, true);
  };
  const observer = new MutationObserver((records) => {
    for (const mutation of records) {
      inspect(mutation.target, true);
      for (const added of mutation.addedNodes) inspect(added, false);
    }
    captureVisible();
  });
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  window.__OSG_E2E_RENDER_ERROR_LEDGER__ = {
    events, get overflow() { return overflow; }, observer,
  };
  captureVisible();
  return true;
}, MAX_RECORDED_RENDER_ERRORS);

export const fingerprint = (path) => {
  const bytes = readFileSync(path);
  return Object.freeze({
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
};

export const renderScratchEntries = (root) => {
  const scratch = join(root, 'cache', 'v1', 'render');
  if (!existsSync(scratch)) return [];
  const entries = [];
  const pending = [scratch];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      assert.equal(metadata.isSymbolicLink(), false, 'the render scratch root contains a symlink');
      entries.push(relative(scratch, path));
      if (metadata.isDirectory()) pending.push(path);
    }
  }
  return entries.sort();
};

export const waitForStableCustomerExport = async (destination, before) => {
  let last = null;
  let exported = null;
  await browser.waitUntil(() => {
    const created = [...listMediaFiles(destination)].filter((path) => !before.has(path)).sort();
    assert.ok(created.length <= 1, `one customer save created multiple files: ${created.join(', ')}`);
    if (created.length === 0) return false;
    assert.ok(MEDIA_EXTENSIONS.has(extname(created[0]).toLowerCase()), (
      `the customer save created an unexpected file type: ${created[0]}`
    ));
    const stat = statSync(created[0]);
    if (!stat.isFile() || stat.size <= 0) return false;
    const current = { path: created[0], ...fingerprint(created[0]), modified: stat.mtimeMs };
    if (last !== null
        && last.path === current.path
        && last.sizeBytes === current.sizeBytes
        && last.modified === current.modified
        && last.sha256 === current.sha256) {
      exported = current.path;
      return true;
    }
    last = current;
    return false;
  }, {
    timeout: 120_000,
    interval: 150,
    timeoutMsg: 'the staged native save produced no single stable media file',
  });
  return exported;
};

export async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
