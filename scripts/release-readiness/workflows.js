'use strict';

// GitHub Actions supply chain and credential scope: reviewed full-SHA action pins, immutable
// runners, pinned toolchains, read-only tokens, signing secrets confined to the signed jobs, and
// the release gates every CI build must run.

const {
  RELEASE_MATRIX,
  REPOSITORY_ROOT,
  escapeRegularExpression,
  invariant,
  readText,
} = require('./shared');
const { PYTHON_VERSION } = require('./toolchains');
const { assertTauriNsisBootstrapScript } = require('./nsis-bootstrap');

const WORKFLOW_PATH = '.github/workflows/rewrite-ci.yml';
const UPDATER_SMOKE_WORKFLOW_PATH = '.github/workflows/updater-smoke.yml';
const TAURI_NSIS_BOOTSTRAP_PATH = 'scripts/prepare-tauri-nsis.ps1';
const SIGNING_SECRETS = Object.freeze(['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']);

const ACTION_PINS = Object.freeze({
  'actions/checkout': 'de0fac2e4500dabe0009e67214ff5f5447ce83dd',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/setup-python': 'a309ff8b426b58ec0e2a45f0f869d46889d02405',
  'actions/upload-artifact': 'b7c566a772e6b6bfb58ed0dc250532a479d7789f',
});

/** The locked gates every CI build must run; removing one silently weakens the release. */
const REQUIRED_CI_GATES = Object.freeze([
  'npm ci --ignore-scripts',
  'npm --prefix apps/desktop ci --ignore-scripts',
  'cargo fetch --locked --target "${{ matrix.rust-target }}"',
  'cargo clippy --workspace --all-targets --features osg-desktop/production --locked --target "${{ matrix.rust-target }}" -- -D warnings',
  'cargo test --workspace --features osg-desktop/production --locked --target "${{ matrix.rust-target }}"',
  'node scripts/check-release-readiness.js --profile compile',
  'node scripts/check-release-readiness.js --profile host-toolchain',
  'node scripts/check-release-readiness.js --profile runtime-package --target "${{ matrix.rust-target }}"',
  'node scripts/check-release-artifacts.js --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}" --allow-unsigned-branch-build',
]);

function assertPinnedActions(workflow) {
  const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );
  invariant(uses.length > 0, 'The workflow does not use any actions');

  for (const actionReference of uses) {
    if (actionReference.startsWith('./') || actionReference.startsWith('docker://')) {
      continue;
    }
    const match = actionReference.match(/^([^@]+)@([0-9a-f]{40})$/i);
    invariant(match, `GitHub Action ${actionReference} must be pinned to a full commit SHA`);
    const expectedPin = ACTION_PINS[match[1]];
    invariant(expectedPin, `GitHub Action ${match[1]} is not on the reviewed action allowlist`);
    invariant(
      match[2].toLowerCase() === expectedPin,
      `GitHub Action ${match[1]} must use reviewed pin ${expectedPin}`,
    );
  }

  for (const [action, pin] of Object.entries(ACTION_PINS)) {
    invariant(uses.includes(`${action}@${pin}`), `The workflow must use ${action}@${pin}`);
  }
}

function assertWorkflowMatrix(workflow) {
  invariant(!/\b(?:ubuntu|macos|windows)-latest\b/i.test(workflow), 'Runner labels must not use mutable *-latest aliases');

  const platformBlocks = [...workflow.matchAll(/^\s{10}- platform:\s*([^\r\n]+)\r?\n([\s\S]*?)(?=^\s{10}- platform:|^\s{4}steps:)/gm)];
  invariant(
    platformBlocks.length === RELEASE_MATRIX.length,
    `Native matrix must contain exactly ${RELEASE_MATRIX.length} explicit platform entries`,
  );

  for (const expected of RELEASE_MATRIX) {
    const block = platformBlocks.find((candidate) => candidate[1].trim() === expected.platform);
    invariant(block, `Native matrix is missing ${expected.platform}`);
    invariant(
      new RegExp(`^\\s*os:\\s*${escapeRegularExpression(expected.os)}\\s*$`, 'm').test(block[2]),
      `${expected.platform} must use ${expected.os}`,
    );
    invariant(
      new RegExp(`^\\s*rust-target:\\s*${escapeRegularExpression(expected.target)}\\s*$`, 'm').test(block[2]),
      `${expected.platform} must build ${expected.target}`,
    );
    invariant(
      new RegExp(`^\\s*bundles:\\s*["']?${escapeRegularExpression(expected.bundles)}["']?\\s*$`, 'm').test(block[2]),
      `${expected.platform} must smoke-package ${expected.bundles}`,
    );
  }
}

function workflowJobBlock(workflow, jobName) {
  const heading = new RegExp(`^  ${escapeRegularExpression(jobName)}:\\s*$`, 'm').exec(workflow);
  invariant(heading, `Workflow is missing job ${jobName}`);
  const tail = workflow.slice(heading.index + heading[0].length);
  const nextJob = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(tail);
  return nextJob ? tail.slice(0, nextJob.index) : tail;
}

function assertWorkflowToolchainPins(workflow) {
  const checkout = `actions/checkout@${ACTION_PINS['actions/checkout']}`;
  const setupNode = `actions/setup-node@${ACTION_PINS['actions/setup-node']}`;
  const setupPython = `actions/setup-python@${ACTION_PINS['actions/setup-python']}`;
  for (const jobName of ['invariants', 'native-matrix', 'windows-installed-smoke']) {
    const job = workflowJobBlock(workflow, jobName);
    invariant(job.includes(`uses: ${checkout}`), `${jobName} must use the reviewed checkout action`);
    invariant(
      job.includes(`uses: ${setupNode}`) && job.includes('node-version-file: .node-version'),
      `${jobName} must install Node through the reviewed setup-node action and .node-version`,
    );
    invariant(
      job.includes(`uses: ${setupPython}`),
      `${jobName} must install Python through the reviewed setup-python action`,
    );
    invariant(
      job.includes(`python-version: "${PYTHON_VERSION}"`),
      `${jobName} must pin Python ${PYTHON_VERSION}`,
    );
    invariant(
      job.includes('node scripts/check-release-readiness.js --profile host-toolchain'),
      `${jobName} must verify the effective Python toolchain with host-toolchain readiness`,
    );
    invariant(
      /npm install --global "\$\(node -p 'require\("\.\/(?:apps\/desktop\/)?package\.json"\)\.packageManager'\)"/
        .test(job),
      `${jobName} must install npm from its exact packageManager pin`,
    );
  }
}

/** Read-only token, no fork-code trigger, and no persisted Git credentials in any checkout. */
function assertReadOnlyRepositoryAccess(workflow, label) {
  invariant(!/^\s*pull_request_target\s*:/m.test(workflow),
    `${label} must not execute fork code through pull_request_target`);
  invariant(
    /^permissions:\s*\r?\n\s{2}contents:\s*read\s*$/m.test(workflow) &&
      !/^\s{2,}[a-z-]+:\s*write\s*$/m.test(workflow),
    `${label} permissions must remain contents: read only`,
  );
  const checkoutCount = (workflow.match(/uses:\s*actions\/checkout@/g) || []).length;
  const nonPersistingCheckoutCount = (workflow.match(/persist-credentials:\s*false/g) || []).length;
  invariant(
    checkoutCount > 0 && nonPersistingCheckoutCount === checkoutCount,
    'Every checkout step must disable persisted Git credentials',
  );
}

function secretNames(source) {
  return [...source.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*}}/g)].map((match) => match[1]);
}

function assertSigningSecretScope(workflow) {
  const signedUpdaterWrapper = workflowJobBlock(workflow, 'signed-updater-smoke');
  const authenticatedInstalledSmoke = workflowJobBlock(workflow, 'windows-installed-smoke');
  invariant(
    /^\s{4}if: github\.event_name == 'workflow_dispatch' && inputs\.job == 'signed-updater-smoke'\s*$/m
      .test(signedUpdaterWrapper)
      && signedUpdaterWrapper.includes('uses: ./.github/workflows/updater-smoke.yml')
      && SIGNING_SECRETS.every((secret) => signedUpdaterWrapper.includes(
        `${secret}: \${{ secrets.${secret} }}`,
      )),
    'Only the manual signed-updater wrapper may forward the two reviewed signing secrets',
  );
  invariant(
    /^\s{4}if: github\.event_name == 'workflow_dispatch' && inputs\.job == 'installed-smoke'\s*$/m
      .test(authenticatedInstalledSmoke)
      && JSON.stringify(secretNames(authenticatedInstalledSmoke).sort())
        === JSON.stringify([...SIGNING_SECRETS]),
    'Only the manual installed smoke may authenticate its package receipt with the updater key',
  );
  const unsignedWorkflow = workflow
    .replace(signedUpdaterWrapper, '')
    .replace(authenticatedInstalledSmoke, '');
  invariant(!/\$\{\{\s*secrets\./i.test(unsignedWorkflow),
    'Unsigned CI jobs must not depend on repository secrets');
  invariant(
    !/(?:TAURI_SIGNING_PRIVATE_KEY|APPLE_CERTIFICATE|APPLE_SIGNING_IDENTITY|CSC_LINK|WIN_CSC_LINK|WINDOWS_CERTIFICATE)/i.test(unsignedWorkflow),
    'Unsigned CI jobs must not configure code-signing credentials',
  );
  invariant(!unsignedWorkflow.includes('ci-updater-fixture'),
    'Ordinary rewrite CI jobs must remain updater-fixture-free');
}

function assertWorkflowCommands(workflow) {
  for (const gate of REQUIRED_CI_GATES) {
    invariant(workflow.includes(gate), `The workflow is missing required locked gate: ${gate}`);
  }
  assertWorkflowToolchainPins(workflow);
  invariant(
    workflowJobBlock(workflow, 'native-matrix').includes(
      'run: node apps/desktop/node_modules/@tauri-apps/cli/tauri.js build --features production --no-bundle --ci --target "${{ matrix.rust-target }}" -- --locked',
    ),
    'native-matrix must compile release executables through the production-feature Tauri wrapper',
  );
  // The local-test channel switches the updater off, which is correct for a build handed to someone
  // for an afternoon and wrong for one anybody installs. No workflow may build with it: an installed
  // release that never checks for updates is indistinguishable from one that is already current.
  invariant(
    !workflow.includes('unsigned-local-build'),
    'No release workflow may build the updater-disabled local-test channel',
  );
  invariant(!/CI:\s*["']?false["']?/i.test(workflow), 'CI builds must not suppress frontend warnings with CI=false');
  assertReadOnlyRepositoryAccess(workflow, 'Build workflow');
  assertSigningSecretScope(workflow);
}

function assertUpdaterSmokeWorkflow(workflow) {
  assertPinnedActions(workflow);
  invariant(/^on:\s*\r?\n\s{2}workflow_dispatch:\s*\r?\n\s{2}workflow_call:\s*$/m.test(workflow)
    && !/^\s{2}(?:push|pull_request|pull_request_target|schedule):/m.test(workflow),
  'Signed updater smoke must be input-free explicit workflow_dispatch/workflow_call only');
  assertReadOnlyRepositoryAccess(workflow, 'Signed updater smoke');
  const unreviewedSecrets = secretNames(workflow).filter((name) => !SIGNING_SECRETS.includes(name));
  invariant(unreviewedSecrets.length === 0,
    `Signed updater smoke may consume only the two reviewed updater signing secrets: ${unreviewedSecrets.join(', ')}`);
  invariant(!workflow.includes('unsigned-local-build'),
    'Signed updater smoke may not build the updater-disabled local-test channel');
  invariant(!/github\.com\/[^\s]+\/releases\/download/i.test(workflow),
    'Signed updater smoke must not publish or consume a public application prerelease');
  invariant(!/(?:osg-updater-fixture\.pfx|TAURI_SIGNING_PRIVATE_KEY)[^\r\n]*runner\.temp.*upload/i.test(workflow),
    'Signed updater smoke must not upload its signing material or ephemeral certificate');
}

function assertWorkflow(rootDirectory = REPOSITORY_ROOT) {
  const workflow = readText(rootDirectory, WORKFLOW_PATH);
  assertPinnedActions(workflow);
  assertWorkflowMatrix(workflow);
  assertWorkflowCommands(workflow);
  assertUpdaterSmokeWorkflow(readText(rootDirectory, UPDATER_SMOKE_WORKFLOW_PATH));
  assertTauriNsisBootstrapScript(readText(rootDirectory, TAURI_NSIS_BOOTSTRAP_PATH));
}

module.exports = {
  ACTION_PINS,
  assertPinnedActions,
  assertUpdaterSmokeWorkflow,
  assertWorkflow,
  assertWorkflowCommands,
  assertWorkflowMatrix,
};
