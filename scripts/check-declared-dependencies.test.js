'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CONFIGURED_CONSUMERS,
  collectStaleConfiguredConsumers,
  collectUndeclared,
  packageNameOf,
  run,
} = require('./check-declared-dependencies');

/**
 * This gate exists because the gate that appeared to cover undeclared dependencies cannot.
 *
 * `npm ls --all` compares the installed tree to the manifests and never reads an import, so a
 * source may require a package no manifest names and `npm ls` still exits 0. That is asserted below
 * against a real temporary project rather than described, because "npm ls does not do this" is
 * exactly the kind of claim that ages badly.
 */

const withProject = (files, callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-declared-deps-'));
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

test('the repository itself passes', () => {
  assert.doesNotThrow(() => run());
});

test('an import of an undeclared package is reported with its file and specifier', () => {
  withProject({
    'package.json': JSON.stringify({ name: 'fixture', devDependencies: { declared: '1.0.0' } }),
    'scripts/uses-undeclared.js': "require('left-pad');\nrequire('declared');\n",
  }, (root) => {
    const undeclared = collectUndeclared(root);
    assert.equal(undeclared.length, 1);
    assert.equal(undeclared[0].package, 'left-pad');
    assert.equal(undeclared[0].file, 'scripts/uses-undeclared.js');
  });
});

test('every import form is seen, not only require', () => {
  withProject({
    'package.json': JSON.stringify({ name: 'fixture' }),
    'scripts/forms.mjs': [
      "import a from 'static-import';",
      "import 'bare-side-effect';",
      "const b = await import('dynamic-import');",
      "const c = require('common-js');",
      "export { d } from 'reexport';",
    ].join('\n'),
  }, (root) => {
    const names = collectUndeclared(root).map((item) => item.package).sort();
    assert.deepEqual(names, [
      'bare-side-effect', 'common-js', 'dynamic-import', 'reexport', 'static-import',
    ]);
  });
});

test('builtins, relative paths and subpaths are not dependencies', () => {
  withProject({
    'package.json': JSON.stringify({ name: 'fixture', dependencies: { '@scope/pkg': '1.0.0' } }),
    'scripts/fine.js': [
      "require('node:fs');",
      "require('path');",
      "require('./sibling');",
      "require('../parent/thing');",
      "require('@scope/pkg/deep/subpath');",
    ].join('\n'),
  }, (root) => {
    assert.deepEqual(collectUndeclared(root), []);
  });
});

test('a workspace source may use a root dependency, because npm hoists', () => {
  withProject({
    'package.json': JSON.stringify({ name: 'root', devDependencies: { hoisted: '1.0.0' } }),
    'promptdj-midi/package.json': JSON.stringify({ name: 'child' }),
    'promptdj-midi/src/uses-root.js': "require('hoisted');\n",
  }, (root) => {
    assert.deepEqual(collectUndeclared(root), []);
  });
});

test('the configured-consumer list rots loudly rather than silently', () => {
  withProject({
    'package.json': JSON.stringify({ name: 'fixture' }),
  }, (root) => {
    // esbuild is a configured consumer of the real repository; a project that does not declare it
    // must report the list as stale rather than quietly accepting it.
    const stale = collectStaleConfiguredConsumers(root);
    assert.equal(stale.length, CONFIGURED_CONSUMERS.length);
    assert.ok(stale.some((entry) => entry.package === 'esbuild'));
  });
});

test('every configured consumer carries the evidence needed to re-verify it', () => {
  for (const consumer of CONFIGURED_CONSUMERS) {
    assert.ok(consumer.package, 'a configured consumer must name its package');
    assert.ok(consumer.declaredBy, `${consumer.package} must say which manifest declares it`);
    assert.ok(
      typeof consumer.reason === 'string' && consumer.reason.length >= 60,
      `${consumer.package} must say what loads it, or the list becomes unfalsifiable`,
    );
  }
});

test('package names are derived correctly from specifiers', () => {
  assert.equal(packageNameOf('esbuild'), 'esbuild');
  assert.equal(packageNameOf('esbuild/lib/main'), 'esbuild');
  assert.equal(packageNameOf('@scope/pkg'), '@scope/pkg');
  assert.equal(packageNameOf('@scope/pkg/sub/deep'), '@scope/pkg');
});

test('npm ls cannot detect this class, which is why this gate exists', () => {
  // The measurement behind this file. If a future npm learns to read import sites, this test fails
  // and the justification above should be revisited rather than the test deleted.
  const { spawnSync } = require('node:child_process');
  withProject({
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    'scripts/probe.js': "require('a-package-that-does-not-exist');\n",
  }, (root) => {
    const result = spawnSync('npm', ['ls', '--all'], {
      cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
    });
    assert.equal(result.status, 0, 'npm ls still passes over an undeclared import');
    assert.equal(collectUndeclared(root).length, 1, 'this gate does not');
  });
});
