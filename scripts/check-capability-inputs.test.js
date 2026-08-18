'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectUnsupplied, declarationCount, run } = require('./check-capability-inputs');

/**
 * The defect this gate exists for, reproduced as a fixture.
 *
 * A resolver takes a capability, defaults it to "unavailable", and only a test ever supplies it.
 * Every unit test passes and the feature is dead in the product. That is the shape below, reduced
 * to two files.
 */

/** Fixture sources are joined rather than written with escapes; see the gate for why. */
const lines = (...parts) => parts.join(String.fromCharCode(10));

const withSources = (files, callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-capability-'));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents);
    }
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const RESOLVER = lines(
  'export const resolveFace = ({',
  '  family,',
  '  managedPackInstalled = false,',
  '}) => (managedPackInstalled ? family : null);',
);

const CONTROLS = lines(
  'const Controls = ({',
  '  isServiceAvailable = false,',
  '}) => isServiceAvailable;',
);

test('the repository itself passes', () => {
  assert.doesNotThrow(() => run());
});

test('the repository actually has capability parameters to check', () => {
  // A gate that passes because it found nothing is the failure mode this asserts against.
  assert.ok(declarationCount() > 0, 'the check must be inspecting real declarations');
});

test('a capability only a test supplies is reported', () => {
  withSources({
    'resolver.js': RESOLVER,
    'resolver.test.js': "resolveFace({ family: 'X', managedPackInstalled: true });",
  }, (root) => {
    const unsupplied = collectUnsupplied(root);
    assert.equal(unsupplied.length, 1);
    assert.equal(unsupplied[0].name, 'managedPackInstalled');
    assert.equal(unsupplied[0].fallback, 'false');
  });
});

test('a capability a shipping module supplies is accepted', () => {
  withSources({
    'resolver.js': RESOLVER,
    'editor.js': "resolveFace({ family: 'X', managedPackInstalled: probe() });",
    'resolver.test.js': "resolveFace({ family: 'X', managedPackInstalled: true });",
  }, (root) => {
    assert.deepEqual(collectUnsupplied(root), []);
  });
});

test('a JSX prop counts as supplying it', () => {
  withSources({
    'controls.js': CONTROLS,
    'panel.jsx': 'const Panel = () => <Controls isServiceAvailable={ready} />;',
  }, (root) => {
    assert.deepEqual(collectUnsupplied(root), []);
  });
});

test('object shorthand counts as supplying it', () => {
  withSources({
    'controls.js': CONTROLS,
    'caller.js': 'render({ isServiceAvailable });',
  }, (root) => {
    assert.deepEqual(collectUnsupplied(root), []);
  });
});

test('a parameter that is not a capability claim is left alone', () => {
  withSources({
    'thing.js': lines('const thing = ({', '  fallbackLabel = null,', '}) => fallbackLabel;'),
  }, (root) => {
    assert.deepEqual(collectUnsupplied(root), []);
  });
});

test('a truthy default is not this defect and is not reported', () => {
  withSources({
    // Defaulting a capability to TRUE fails loudly the moment it is wrong, which is the opposite of
    // the silent shape this gate hunts.
    'thing.js': lines('const thing = ({', '  isServiceAvailable = true,', '}) => isServiceAvailable;'),
  }, (root) => {
    assert.deepEqual(collectUnsupplied(root), []);
  });
});
