'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { readMutableSource, toCrlf, weaken } = require('../mutation-testing');
const { RELEASE_MATRIX } = require('./shared');
const {
  ACTION_PINS,
  assertPinnedActions,
  assertUpdaterSmokeWorkflow,
  assertWorkflowCommands,
  assertWorkflowMatrix,
} = require('./workflows');
const { assertTauriNsisBootstrapScript } = require('./nsis-bootstrap');
const { REPOSITORY_ROOT } = require('./test-support');

const REWRITE_CI = readMutableSource(REPOSITORY_ROOT, '.github', 'workflows', 'rewrite-ci.yml');
const UPDATER_SMOKE = readMutableSource(REPOSITORY_ROOT, '.github', 'workflows', 'updater-smoke.yml');
const NSIS_BOOTSTRAP = readMutableSource(REPOSITORY_ROOT, 'scripts', 'prepare-tauri-nsis.ps1');

function transformWorkflowJob(workflow, jobName, transform) {
  const heading = `  ${jobName}:`;
  const start = workflow.indexOf(heading);
  assert.notEqual(start, -1, `Missing workflow job ${jobName}`);
  const nextJobOffset = workflow.slice(start + heading.length).search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  const end = nextJobOffset === -1
    ? workflow.length
    : start + heading.length + nextJobOffset;
  return workflow.slice(0, start) + transform(workflow.slice(start, end)) + workflow.slice(end);
}

test('accepts only reviewed full-SHA GitHub Action pins', () => {
  const workflow = Object.entries(ACTION_PINS)
    .map(([action, pin]) => `      - uses: ${action}@${pin}`)
    .join('\n');
  assert.doesNotThrow(() => assertPinnedActions(workflow));
  for (const pin of Object.values(ACTION_PINS)) {
    assert.throws(
      () => assertPinnedActions(weaken(workflow, pin, 'v0')),
      /full commit SHA/,
    );
    assert.throws(
      () => assertPinnedActions(weaken(workflow, pin, '0'.repeat(40))),
      /reviewed pin/,
    );
  }
});

test('requires every immutable host/target/package matrix entry', () => {
  const entries = RELEASE_MATRIX.map(
    ({ platform, os: runner, target, bundles }) =>
      `          - platform: ${platform}\n            os: ${runner}\n            rust-target: ${target}\n            bundles: ${bundles}`,
  ).join('\n');
  const workflow = `      matrix:\n        include:\n${entries}\n\n    steps:\n`;
  assert.doesNotThrow(() => assertWorkflowMatrix(workflow));
  assert.throws(
    () => assertWorkflowMatrix(weaken(workflow, 'os: macos-15', 'os: macos-latest')),
    /mutable \*-latest aliases/,
  );
});

test('rewrite CI is read-only, credential-scoped, pinned, and runs every release gate', () => {
  assert.doesNotThrow(() => assertWorkflowCommands(REWRITE_CI));
  const cases = [
    [weaken(REWRITE_CI, 'contents: read', 'contents: write'), /permissions must remain contents: read only/],
    [
      weaken(REWRITE_CI, 'persist-credentials: false', 'persist-credentials: true'),
      /Every checkout step must disable persisted Git credentials/,
    ],
    [`on:\n  pull_request_target:\n${REWRITE_CI}`, /pull_request_target/],
    [
      weaken(REWRITE_CI, 'node scripts/check-release-readiness.js --profile runtime-package', 'echo skipped'),
      /missing required locked gate/,
    ],
    [
      weaken(
        REWRITE_CI,
        'run: node apps/desktop/node_modules/@tauri-apps/cli/tauri.js build --features production --no-bundle',
        'run: node apps/desktop/node_modules/@tauri-apps/cli/tauri.js build --no-bundle',
      ),
      /production-feature Tauri wrapper/,
    ],
    [`${REWRITE_CI}\n# --features unsigned-local-build\n`, /updater-disabled local-test channel/],
    [
      transformWorkflowJob(REWRITE_CI, 'native-matrix', (job) => weaken(
        job,
        `uses: actions/setup-python@${ACTION_PINS['actions/setup-python']}`,
        '# setup-python removed',
      )),
      /native-matrix must install Python through the reviewed setup-python action/,
    ],
    [
      transformWorkflowJob(REWRITE_CI, 'native-matrix', (job) => (
        `${job}      - run: echo "\${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"\n`
      )),
      /Unsigned CI jobs must not depend on repository secrets/,
    ],
    [
      transformWorkflowJob(REWRITE_CI, 'native-matrix', (job) => (
        `${job}      - run: cargo build --features ci-updater-fixture\n`
      )),
      /updater-fixture-free/,
    ],
    [
      transformWorkflowJob(REWRITE_CI, 'windows-installed-smoke', (job) => (
        `${job}      - run: echo "\${{ secrets.UNREVIEWED_TOKEN }}"\n`
      )),
      /Only the manual installed smoke may authenticate/,
    ],
  ];
  for (const [weakened, expected] of cases) {
    assert.throws(() => assertWorkflowCommands(weakened), expected);
  }
});

test('signed updater smoke is manual, read-only, and confined to the reviewed signing secrets', () => {
  assert.doesNotThrow(() => assertUpdaterSmokeWorkflow(UPDATER_SMOKE));
  const cases = [
    [weaken(UPDATER_SMOKE, 'workflow_dispatch:', 'pull_request_target:'), /workflow_dispatch/],
    [
      weaken(
        UPDATER_SMOKE,
        '  workflow_dispatch:\n  workflow_call:',
        '  workflow_dispatch:\n    inputs:\n      version:\n        required: true\n  workflow_call:',
      ),
      /input-free/,
    ],
    [weaken(UPDATER_SMOKE, 'contents: read', 'contents: write'), /read only/],
    [`${UPDATER_SMOKE}\n# \${{ secrets.UNREVIEWED_SECRET }}\n`, /two reviewed updater signing secrets/],
    [
      `${UPDATER_SMOKE}\n# https://github.com/example/app/releases/download/v1.0.0/app.exe\n`,
      /must not publish or consume a public application prerelease/,
    ],
  ];
  for (const [weakened, expected] of cases) {
    assert.throws(() => assertUpdaterSmokeWorkflow(weakened), expected);
  }
});

test('Tauri NSIS bootstrap downloads only its pinned, verified HTTPS artifacts', () => {
  assert.doesNotThrow(() => assertTauriNsisBootstrapScript(NSIS_BOOTSTRAP));
  assert.doesNotThrow(() => assertTauriNsisBootstrapScript(toCrlf(NSIS_BOOTSTRAP)));
  const zipUrl = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip';
  const weakenedVariants = [
    weaken(NSIS_BOOTSTRAP, zipUrl, 'https://evil.example/nsis-3.11.zip'),
    `${weaken(NSIS_BOOTSTRAP, `    Url = '${zipUrl}'`, "    Url = 'https://evil.example/nsis-3.11.zip'")}\n#    Url = '${zipUrl}'\n`,
    weaken(NSIS_BOOTSTRAP, 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1', '0'.repeat(64)),
    weaken(NSIS_BOOTSTRAP, 'Size = 2361546L', 'Size = 1L'),
    weaken(NSIS_BOOTSTRAP, "--proto-redir '=https'", "--proto-redir '=all'"),
    weaken(
      NSIS_BOOTSTRAP,
      '  Assert-PinnedFile -Path $Destination -Artifact $Artifact',
      '  # response verification removed',
    ),
    weaken(
      NSIS_BOOTSTRAP,
      '  Assert-PinnedFile -Path $Destination -Artifact $Artifact',
      '  return\n<#\n  Assert-PinnedFile -Path $Destination -Artifact $Artifact\n#>',
    ),
    weaken(NSIS_BOOTSTRAP, 'if ($sha256 -cne $Artifact.Sha256) {', 'if ($false) {'),
    `${NSIS_BOOTSTRAP}\nInvoke-WebRequest https://example.test/fallback.zip\n`,
    `${NSIS_BOOTSTRAP}\n# http://example.test/fallback.zip\n`,
  ];
  for (const [index, weakened] of weakenedVariants.entries()) {
    assert.throws(
      () => assertTauriNsisBootstrapScript(weakened),
      /Tauri NSIS bootstrap/,
      `Tauri NSIS hostile mutation ${index} must fail closed`,
    );
  }
});
