'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LF, readMutableSource, weaken } = require('../mutation-testing');
const {
  assertNativeUpdateChannel,
  assertUpdaterFixtureBuildScope,
  assertUpdaterFixtureIsolation,
  assertUpdaterReleaseConfiguration,
} = require('./updater');
const { REPOSITORY_ROOT, writeFile } = require('./test-support');

const DESKTOP_BUILD_SOURCE = readMutableSource(
  REPOSITORY_ROOT, 'apps', 'desktop', 'src-tauri', 'build.rs',
);

test('native stable channel cannot follow legacy Latest or a version-pinned manifest', () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  assert.doesNotThrow(() => assertNativeUpdateChannel(config));
  for (const route of ['latest/download', 'download/v1.0.0', 'download/osg-native-stable', 'download/unreviewed-channel']) {
    const changed = structuredClone(config);
    changed.plugins.updater.endpoints = [
      `https://github.com/nganlinh4/oneclick-subtitles-generator/releases/${route}/osg-desktop-updater-v2.json`,
    ];
    assert.throws(() => assertNativeUpdateChannel(changed), /dedicated native stable channel/);
  }
});

function createUpdaterFixture({
  endpoint = 'https://example.invalid/releases/latest/download/osg-desktop-updater-v2.json',
  permission = 'check-for-updates',
  publicKey = null,
  updaterOverrides = {},
  windowsOverrides = {},
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-updater-readiness-'));
  const keyBytes = Buffer.concat([Buffer.from('Ed'), Buffer.from(Array.from({ length: 40 }, (_, index) => index + 1))]);
  const minisignKey = keyBytes.toString('base64');
  const encodedPublicKey = publicKey ?? Buffer.from(
    `untrusted comment: minisign public key test fixture\n${minisignKey}\n`,
    'utf8',
  ).toString('base64');
  writeFile(root, 'apps/desktop/src-tauri/updater-public-key.txt', `${encodedPublicKey}\n`);
  writeFile(
    root,
    'apps/desktop/src-tauri/tauri.conf.json',
    JSON.stringify({
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          endpoints: [endpoint],
          pubkey: '',
          windows: { installMode: 'passive', ...windowsOverrides },
          ...updaterOverrides,
        },
      },
    }),
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/capabilities/main.json',
    JSON.stringify({ permissions: [permission] }),
  );
  return root;
}

test('signed updater release gate requires a real key, HTTPS latest.json, and no guest API', (context) => {
  const validRoot = createUpdaterFixture();
  const placeholderRoot = createUpdaterFixture({ publicKey: 'UNCONFIGURED' });
  const insecureRoot = createUpdaterFixture({ endpoint: 'http://example.invalid/latest.json' });
  const guestRoot = createUpdaterFixture({ permission: 'updater:default' });
  const transportAndInstallCases = [
    [
      createUpdaterFixture({ updaterOverrides: { dangerousInsecureTransportProtocol: true } }),
      /never allow insecure transport/,
    ],
    [
      createUpdaterFixture({ updaterOverrides: { dangerousAcceptInvalidCerts: true } }),
      /never accept invalid TLS certificates/,
    ],
    [
      createUpdaterFixture({ updaterOverrides: { dangerousAcceptInvalidHostnames: true } }),
      /never accept invalid TLS hostnames/,
    ],
    [
      createUpdaterFixture({ updaterOverrides: { proxy: 'http://proxy.invalid' } }),
      /updater declares unreviewed keys: proxy/,
    ],
    [
      createUpdaterFixture({ windowsOverrides: { installMode: 'quiet' } }),
      /windows\.installMode must stay passive/,
    ],
    [
      createUpdaterFixture({ windowsOverrides: { installerArgs: ['/SILENT'] } }),
      /windows\.installerArgs must stay empty/,
    ],
    [
      createUpdaterFixture({ windowsOverrides: { installerHooks: 'hook.ps1' } }),
      /windows declares unreviewed keys: installerHooks/,
    ],
  ];
  context.after(() => {
    for (const root of [
      validRoot,
      placeholderRoot,
      insecureRoot,
      guestRoot,
      ...transportAndInstallCases.map(([root]) => root),
    ]) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  assert.doesNotThrow(() => assertUpdaterReleaseConfiguration(validRoot));
  assert.throws(() => assertUpdaterReleaseConfiguration(placeholderRoot), /still a placeholder/);
  assert.throws(() => assertUpdaterReleaseConfiguration(insecureRoot), /must use HTTPS/);
  assert.throws(() => assertUpdaterReleaseConfiguration(guestRoot), /must not grant updater guest permissions/);
  for (const [root, expected] of transportAndInstallCases) {
    assert.throws(() => assertUpdaterReleaseConfiguration(root), expected);
  }
});

test('signed updater release gate pins the shipped transport and Windows install invariants', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'),
    'utf8',
  ));
  const updater = config.plugins.updater;
  assert.deepEqual(Object.keys(updater).sort(), ['endpoints', 'pubkey', 'windows']);
  assert.deepEqual(updater.windows, { installMode: 'passive' });
  assert.doesNotThrow(() => assertUpdaterReleaseConfiguration(REPOSITORY_ROOT));
});

test('build.rs refuses the updater fixture outside the isolated GitHub workflow', () => {
  assert.doesNotThrow(() => assertUpdaterFixtureBuildScope(DESKTOP_BUILD_SOURCE));
  const updaterScopeCall = '    verify_ci_updater_fixture_scope();';
  const managedDeliveryCall = '    verify_managed_delivery_contract();';
  const tauriBuildCompletion = [
    '    )',
    '    .expect("failed to generate the Tauri application manifest");',
  ].join(LF);
  const mainCallMutations = [
    ['deleting the updater-scope call', weaken(
      DESKTOP_BUILD_SOURCE,
      `${updaterScopeCall}${LF}`,
      '',
    )],
    ['running the updater-scope call after managed-delivery verification', weaken(
      DESKTOP_BUILD_SOURCE,
      `${updaterScopeCall}${LF}${managedDeliveryCall}`,
      `${managedDeliveryCall}${LF}${updaterScopeCall}`,
    )],
    ['running the updater-scope call only after the Tauri build', weaken(
      weaken(DESKTOP_BUILD_SOURCE, `${updaterScopeCall}${LF}`, ''),
      tauriBuildCompletion,
      `${tauriBuildCompletion}${LF}${updaterScopeCall}`,
    )],
    ['making the updater-scope call conditional', weaken(
      DESKTOP_BUILD_SOURCE,
      updaterScopeCall,
      [
        '    if std::env::var_os("CI").is_some() {',
        `    ${updaterScopeCall}`,
        '    }',
      ].join(LF),
    )],
    ['hiding the updater-scope call in unreachable control flow', weaken(
      DESKTOP_BUILD_SOURCE,
      updaterScopeCall,
      [
        '    if false {',
        `    ${updaterScopeCall}`,
        '    }',
      ].join(LF),
    )],
  ];
  for (const [label, weakened] of mainCallMutations) {
    assert.throws(
      () => assertUpdaterFixtureBuildScope(weakened),
      /must run first and unconditionally, before managed delivery and the Tauri build/u,
      label,
    );
  }
  for (const weakened of [
    weaken(DESKTOP_BUILD_SOURCE, 'Ok("debug")', 'Ok("release")'),
    weaken(
      DESKTOP_BUILD_SOURCE,
      '|| matches!(std::env::var("PROFILE").as_deref(), Ok("debug"))',
      '|| std::env::var("PROFILE").as_deref() != Ok("release")',
    ),
    weaken(
      DESKTOP_BUILD_SOURCE,
      '|| matches!(std::env::var("PROFILE").as_deref(), Ok("debug"))',
      '',
    ),
  ]) {
    assert.throws(
      () => assertUpdaterFixtureBuildScope(weakened),
      /exempt only Cargo debug builds/u,
    );
  }
  const githubActionsAssertion = [
    '    assert_eq!(',
    '        std::env::var("GITHUB_ACTIONS").as_deref(),',
    '        Ok("true"),',
    '        "the signed updater fixture may be compiled only on GitHub Actions"',
    '    );',
  ].join(LF);
  const explicitOptInAssertion = [
    '    assert_eq!(',
    '        std::env::var("OSG_ENABLE_SIGNED_UPDATER_FIXTURE").as_deref(),',
    '        Ok("1"),',
    '        "the signed updater fixture requires an explicit isolated-workflow opt-in"',
    '    );',
  ].join(LF);
  const assertionMutations = [
    ['deleting the GitHub Actions assertion', weaken(
      DESKTOP_BUILD_SOURCE,
      githubActionsAssertion,
      '',
    )],
    ['replacing the GitHub Actions assertion with a value reference', weaken(
      DESKTOP_BUILD_SOURCE,
      githubActionsAssertion,
      '    let _ = ("GITHUB_ACTIONS", Ok("true"));',
    )],
    ['accepting a non-GitHub truthy spelling', weaken(
      DESKTOP_BUILD_SOURCE,
      githubActionsAssertion,
      githubActionsAssertion.replace('Ok("true")', 'Ok("1")'),
    )],
    ['deleting the explicit opt-in assertion', weaken(
      DESKTOP_BUILD_SOURCE,
      explicitOptInAssertion,
      '',
    )],
    ['replacing the explicit opt-in assertion with a value reference', weaken(
      DESKTOP_BUILD_SOURCE,
      explicitOptInAssertion,
      '    let _ = ("OSG_ENABLE_SIGNED_UPDATER_FIXTURE", Ok("1"));',
    )],
    ['accepting a non-explicit opt-in spelling', weaken(
      DESKTOP_BUILD_SOURCE,
      explicitOptInAssertion,
      explicitOptInAssertion.replace('Ok("1")', 'Ok("true")'),
    )],
    ['putting the explicit opt-in before the GitHub Actions assertion', weaken(
      DESKTOP_BUILD_SOURCE,
      `${githubActionsAssertion}${LF}${explicitOptInAssertion}`,
      `${explicitOptInAssertion}${LF}${githubActionsAssertion}`,
    )],
    ['hiding an exact GitHub Actions assertion in an unreachable branch', weaken(
      DESKTOP_BUILD_SOURCE,
      githubActionsAssertion,
      `    if false {${LF}${githubActionsAssertion}${LF}    }`,
    )],
  ];
  for (const [label, weakened] of assertionMutations) {
    assert.throws(
      () => assertUpdaterFixtureBuildScope(weakened),
      /must require GITHUB_ACTIONS == "true".*OSG_ENABLE_SIGNED_UPDATER_FIXTURE == "1"/u,
      label,
    );
  }
});

test('the desktop updater fixture stays compile-time isolated from production releases', () => {
  assert.doesNotThrow(() => assertUpdaterFixtureIsolation(REPOSITORY_ROOT));
});
