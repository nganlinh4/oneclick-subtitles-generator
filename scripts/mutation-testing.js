'use strict';

/**
 * Mutation-testing primitives shared by the release gates' own tests.
 *
 * Several gates are proven the only way a gate can be proven: weaken a real source, then require
 * the gate to reject the weakened copy. That proof is worth exactly nothing unless the weakening
 * actually happened, and it silently stopped happening on Windows.
 *
 * `.gitattributes` pins `eol=lf` for `*.mjs`, `*.py`, `*.json`, `*.css` and friends, but `*.js`,
 * `*.jsx`, `*.ps1`, `*.rs`, `*.toml`, `*.yml` and `Cargo.lock` fall through to `text` /
 * `text=auto`. With `core.autocrlf=true` -- the default a Windows contributor gets, and what this
 * machine has -- git checks those out with CRLF. `*.ps1` matters most: PowerShell sources are
 * behind three of the five suites this fixes. Every search string in these suites is written with
 * LF, so `String.prototype.replace` found nothing, handed back its input unchanged, and
 * `assert.throws` then ran the gate against a fixture identical to the source it was supposed to
 * have broken.
 *
 * WHAT THAT ACTUALLY LOOKED LIKE, measured rather than assumed. On a faithful fresh-Windows-clone
 * simulation of the pre-fix code, 13 of 262 executed mutation sites were silent no-ops -- and every
 * one of them sat in a test that went RED. No test was green while asserting nothing; the failure
 * mode was a gate that fails on Windows for a reason that has nothing to do with what it guards,
 * which is how a real regression gets lost in noise the next person learns to ignore. Five tests in
 * `check-release-readiness.test.js` failed that way, not two. An earlier draft of this comment said
 * "two release gates were green and asserting nothing" -- wrong on both counts, and recorded here
 * because a mutation-testing helper that misdescribes its own defect is the exact failure it exists
 * to prevent.
 *
 * Two independent defences, because either one alone can be forgotten:
 *   1. `readMutableSource` normalises line endings at the read boundary, so an LF search string
 *      matches on every platform and every checkout.
 *   2. `weaken` / `weakenAll` refuse to return a fixture byte-identical to their input. A search
 *      that matches nothing is now a loud failure rather than a silent pass.
 *
 * Reach for a raw `fs.readFileSync` only when the on-disk bytes are themselves the subject.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CRLF = CR + LF;

const normalizeLineEndings = (text) => text.split(CRLF).join(LF);

/** Read a source that is about to be mutated, with its line endings normalised to LF. */
const readMutableSource = (...segments) => normalizeLineEndings(
  fs.readFileSync(path.join(...segments), 'utf8'),
);

/** The CRLF twin of a source, for gates that must also hold on a stock Windows checkout. */
const toCrlf = (text) => normalizeLineEndings(text).split(LF).join(CRLF);

const describeSearch = (search) => (search instanceof RegExp
  ? String(search)
  : JSON.stringify(search.length > 120 ? `${search.slice(0, 120)}…` : search));

/** Non-overlapping occurrence count, for string and regular-expression searches alike. */
const countOccurrences = (source, search) => {
  if (search instanceof RegExp) {
    const flags = search.flags.includes('g') ? search.flags : `${search.flags}g`;
    return (source.match(new RegExp(search.source, flags)) || []).length;
  }
  assert.notEqual(search, '', 'A mutation search string must not be empty');
  let count = 0;
  for (let at = source.indexOf(search); at !== -1; at = source.indexOf(search, at + search.length)) {
    count += 1;
  }
  return count;
};

const mutationFailure = (source, search, detail) => {
  const carriageReturns = countOccurrences(source, CR);
  const hint = carriageReturns > 0
    ? ` This source still holds ${carriageReturns} CR bytes; read it through readMutableSource().`
    : '';
  return `${detail} Search: ${describeSearch(search)}.${hint}`;
};

function mutate(method, source, search, replacement, options = {}) {
  assert.equal(typeof source, 'string', 'A mutation target must be a string');
  assert.notEqual(source, '', 'A mutation target must not be empty');
  const matches = countOccurrences(source, search);
  if (matches === 0) {
    assert.fail(mutationFailure(
      source,
      search,
      'Mutation target is absent, so this test would have asserted nothing.',
    ));
  }
  if (options.expected !== undefined && matches !== options.expected) {
    assert.fail(mutationFailure(
      source,
      search,
      `Mutation target occurs ${matches} times, expected exactly ${options.expected}.`,
    ));
  }
  const mutated = source[method](search, replacement);
  if (mutated === source) {
    assert.fail(mutationFailure(
      source,
      search,
      'Mutation left the source byte-identical, so this test would have asserted nothing.',
    ));
  }
  return mutated;
}

/** Weaken the first occurrence, proving the fixture really changed. */
const weaken = (source, search, replacement, options) =>
  mutate('replace', source, search, replacement, options);

/** Weaken every occurrence, proving the fixture really changed. */
const weakenAll = (source, search, replacement, options) =>
  mutate('replaceAll', source, search, replacement, options);

module.exports = {
  CR,
  CRLF,
  LF,
  countOccurrences,
  normalizeLineEndings,
  readMutableSource,
  toCrlf,
  weaken,
  weakenAll,
};
