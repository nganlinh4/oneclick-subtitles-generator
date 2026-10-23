'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CR,
  LF,
  countOccurrences,
  normalizeLineEndings,
  toCrlf,
  weaken,
  weakenAll,
} = require('./mutation-testing');

// The guard that makes every other mutation in this file mean something. It has to be proven on
// both line endings, because the platform where it broke is not the platform anyone runs locally.
test('weakening refuses to hand back an unchanged fixture on either line ending', () => {
  const lfSource = ['param(', "  [string]$Phase = 'initial'", ')', 'exit 0', ''].join(LF);
  const crlfSource = toCrlf(lfSource);
  assert.notEqual(lfSource, crlfSource, 'the two fixtures must genuinely differ');
  assert.equal(countOccurrences(crlfSource, CR), 4);
  assert.equal(countOccurrences(lfSource, CR), 0);

  // The original defect, reproduced: an LF search string against CRLF bytes matches nothing.
  const lfSearch = `param(${LF}  [string]$Phase`;
  assert.equal(countOccurrences(lfSource, lfSearch), 1);
  assert.equal(countOccurrences(crlfSource, lfSearch), 0);
  assert.equal(crlfSource.replace(lfSearch, 'MUTATED'), crlfSource);

  // Defence 1: normalising at the read boundary makes the LF search string match either way.
  for (const [label, source] of [['LF', lfSource], ['CRLF', crlfSource]]) {
    const mutated = weaken(normalizeLineEndings(source), lfSearch, 'MUTATED');
    assert.ok(mutated.includes('MUTATED'), `${label} source must weaken after normalisation`);
  }

  // Defence 2: without normalising, the same mutation is a loud failure instead of a silent pass.
  assert.throws(
    () => weaken(crlfSource, lfSearch, 'MUTATED'),
    (error) => {
      assert.match(error.message, /Mutation target is absent/);
      assert.match(error.message, /still holds 4 CR bytes/);
      assert.match(error.message, /readMutableSource/);
      return true;
    },
  );

  // A search that is present but whose replacement changes nothing is equally vacuous.
  assert.throws(
    () => weaken(lfSource, 'exit 0', 'exit 0'),
    /Mutation left the source byte-identical/,
  );

  // Cardinality is checkable where it carries meaning.
  const repeated = [lfSource, lfSource].join(LF);
  assert.throws(
    () => weaken(repeated, 'exit 0', 'exit 1', { expected: 1 }),
    /occurs 2 times, expected exactly 1/,
  );
  assert.doesNotThrow(() => weakenAll(repeated, 'exit 0', 'exit 1', { expected: 2 }));

  // Regular-expression searches are counted and proven the same way.
  assert.throws(
    () => weaken(lfSource, /\$Phase\s*=\s*'reactivation'/, 'x'),
    /Mutation target is absent/,
  );
  assert.doesNotThrow(() => weaken(lfSource, /\$Phase\s*=\s*'initial'/, "$Phase = 'x'"));
});
