'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  assertHarnessSeamsAreCompiledOut,
  assertUpdaterFixtureSeamsAreCompiledOut,
} = require('./harness-seams');
const { REPOSITORY_ROOT, temporaryRoot } = require('./test-support');

test('harness seam guard accepts a test-or-automation cfg and rejects an unguarded read', (context) => {
  const root = temporaryRoot(context, 'osg-harness-seam-readiness-');
  const sourceDirectory = path.join(root, 'apps', 'desktop', 'src-tauri', 'src');
  const sourcePath = path.join(sourceDirectory, 'automation.rs');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(
    sourcePath,
    '#[cfg(any(feature = "e2e-automation", test))]\nconst TOKEN: &str = "OSG_E2E_TOKEN";\n',
  );
  assert.equal(assertHarnessSeamsAreCompiledOut(root), 1);

  fs.writeFileSync(
    sourcePath,
    '#[cfg(feature = "e2e-automation")]\n'
      + 'const TOKEN: &str = "OSG_E2E_TOKEN";\n'
      + 'fn sanitize(command: &mut std::process::Command) {\n'
      + '    command.env_remove("OSG_E2E_TOKEN");\n'
      + '}\n',
  );
  assert.equal(
    assertHarnessSeamsAreCompiledOut(root),
    1,
    'removing a harness variable from a child process is not an automation input seam',
  );

  fs.writeFileSync(sourcePath, 'const TOKEN: &str = "OSG_E2E_TOKEN";\n');
  assert.throws(
    () => assertHarnessSeamsAreCompiledOut(root),
    /without a test-only cfg guard above it/u,
  );

  for (const unsafeGuard of [
    '#[cfg(any(feature = "e2e-automation", feature = "production"))]',
    '#[cfg(any(feature = "e2e-automation", not(test)))]',
    '#[cfg(feature = "production")]',
  ]) {
    fs.writeFileSync(sourcePath, `${unsafeGuard}\nconst TOKEN: &str = "OSG_E2E_TOKEN";\n`);
    assert.throws(
      () => assertHarnessSeamsAreCompiledOut(root),
      /without a test-only cfg guard above it/u,
      `${unsafeGuard} can compile the harness seam into production`,
    );
  }

  fs.writeFileSync(
    sourcePath,
    '#[cfg(all(target_os = "windows", feature = "e2e-automation"))]\n'
      + 'fn guarded_with_local_const() {\n'
      + '    const CREATE_NO_WINDOW: u32 = 1;\n'
      + '    let _ = (CREATE_NO_WINDOW, "OSG_E2E_TOKEN");\n'
      + '}\n',
  );
  assert.equal(assertHarnessSeamsAreCompiledOut(root), 1);

  fs.writeFileSync(
    sourcePath,
    '#[cfg(feature = "e2e-automation")]\n'
      + 'fn guarded_sibling() { let _ = "not an environment read"; }\n\n'
      + 'fn production_sibling() {\n'
      + '    let _ = std::env::var_os("OSG_E2E_TOKEN");\n'
      + '}\n',
  );
  assert.throws(
    () => assertHarnessSeamsAreCompiledOut(root),
    /without a test-only cfg guard above it/u,
    'an unguarded item borrowed the preceding sibling guard',
  );
});

test('a guarded multi-line statement owns its seam, and an unguarded one does not', (context) => {
  const root = temporaryRoot(context, 'osg-harness-statement-readiness-');
  const sourcePath = path.join(root, 'apps', 'desktop', 'src-tauri', 'src', 'updater.rs');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const statement = (guard) => [
    'fn build_updater(builder: Builder) -> Builder {',
    '    let builder = builder.timeout(1);',
    ...(guard ? ['    #[cfg(feature = "ci-updater-fixture")]'] : []),
    '    let builder = builder',
    '        .endpoints(vec![CI_UPDATE_ENDPOINT])',
    '        // self-signed fixture transport',
    '        .configure_client(|client| client.danger_accept_invalid_certs(true));',
    '    builder',
    '}',
    '',
  ].join('\n');

  fs.writeFileSync(sourcePath, statement(true));
  assert.equal(assertUpdaterFixtureSeamsAreCompiledOut(root), 1);

  fs.writeFileSync(sourcePath, statement(false));
  assert.throws(
    () => assertUpdaterFixtureSeamsAreCompiledOut(root),
    /updater\.rs:6 uses the CI updater fixture transport or debug port without a test-only cfg guard/u,
  );
});

test('a test-only inner cfg guards a whole fixture module', (context) => {
  const root = temporaryRoot(context, 'osg-harness-module-readiness-');
  const sourcePath = path.join(root, 'apps', 'desktop', 'src-tauri', 'src', 'ci_updater_fixture.rs');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const body = 'fn arguments(port: u16) -> String {\n    format!("--remote-debugging-port={port}")\n}\n';

  fs.writeFileSync(sourcePath, `#![cfg(feature = "ci-updater-fixture")]\n\n${body}`);
  assert.equal(assertUpdaterFixtureSeamsAreCompiledOut(root), 1);

  fs.writeFileSync(sourcePath, `#![cfg(any(feature = "ci-updater-fixture", feature = "production"))]\n${body}`);
  assert.throws(() => assertUpdaterFixtureSeamsAreCompiledOut(root), /without a test-only cfg guard/u);
});

test('the desktop sources keep every harness and updater-fixture seam compiled out', () => {
  assert.ok(assertHarnessSeamsAreCompiledOut(REPOSITORY_ROOT) > 0);
  assert.ok(assertUpdaterFixtureSeamsAreCompiledOut(REPOSITORY_ROOT) > 0);
});
