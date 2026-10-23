'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertEffectiveToolchain,
  assertLockfiles,
  assertPinnedToolchains,
} = require('./toolchains');
const { writeFile } = require('./test-support');

function createDependencyPinFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-dependency-pins-'));
  const rootPackage = {
    packageManager: 'npm@11.17.0',
    dependencies: {
      '@tauri-apps/api': '2.11.1',
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
    devDependencies: {
      '@tauri-apps/cli': '2.11.4',
      '7zip-bin-full': '26.2.1',
    },
  };
  const workspacePackage = {
    dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
  };
  writeFile(root, '.node-version', '24.19.0\n');
  writeFile(root, 'package.json', JSON.stringify(rootPackage));
  writeFile(
    root,
    'apps/desktop/package.json',
    JSON.stringify({
      packageManager: 'npm@11.17.0',
      devDependencies: { '@tauri-apps/cli': '2.11.4' },
    }),
  );
  writeFile(root, 'promptdj-midi/package.json', JSON.stringify(workspacePackage));
  writeFile(
    root,
    'rust-toolchain.toml',
    '[toolchain]\nchannel = "1.97.1"\nprofile = "minimal"\ncomponents = ["clippy", "rustfmt"]\n',
  );
  writeFile(
    root,
    'Cargo.toml',
    '[workspace]\nmembers = ["crates/example"]\n\n[workspace.package]\nrust-version = "1.97"\n',
  );
  return { root, rootPackage, workspacePackage };
}

test('pins the reviewed React pair and release inspection dependency in every manifest', (context) => {
  const { root, rootPackage } = createDependencyPinFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.doesNotThrow(() => assertPinnedToolchains(root));

  rootPackage.dependencies.react = '^18.2.0';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPackage));
  assert.throws(
    () => assertPinnedToolchains(root),
    /package\.json must pin React and React DOM to the reviewed 18\.3\.1 pair/,
  );

  rootPackage.dependencies.react = '18.3.1';
  rootPackage.devDependencies['7zip-bin-full'] = '^26.2.1';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPackage));
  assert.throws(
    () => assertPinnedToolchains(root),
    /must pin 7zip-bin-full to exact version 26\.2\.1/,
  );
});

test('lockfiles bind reviewed registry artifacts and exact React workspace parity', (context) => {
  const { root } = createDependencyPinFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const genericIntegrity = `sha512-${Buffer.alloc(64, 0x5a).toString('base64')}`;
  const tauriCli = {
    version: '2.11.4',
    resolved: 'https://registry.npmjs.org/@tauri-apps/cli/-/cli-2.11.4.tgz',
    integrity: genericIntegrity,
  };
  const rootLock = {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        devDependencies: { '7zip-bin-full': '26.2.1' },
      },
      'node_modules/@tauri-apps/cli': tauriCli,
      'node_modules/7zip-bin-full': {
        version: '26.2.1',
        resolved: 'https://registry.npmjs.org/7zip-bin-full/-/7zip-bin-full-26.2.1.tgz',
        integrity: 'sha512-h1DE4G8WEJ3/LI4HTcuOpouP7cy9JGqYfZm5fzLhdzw8jI3wFyA9RFu5MP+ICzelKEYmWweRWApEvVWKmJIdVQ==',
        dev: true,
        license: 'MIT',
      },
      'node_modules/react': {
        version: '18.3.1',
        resolved: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz',
        integrity: genericIntegrity,
      },
      'node_modules/react-dom': {
        version: '18.3.1',
        resolved: 'https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz',
        integrity: genericIntegrity,
      },
      'promptdj-midi': {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        link: true,
      },
    },
  };
  const desktopLock = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/@tauri-apps/cli': tauriCli,
    },
  };
  writeFile(root, 'package-lock.json', JSON.stringify(rootLock));
  writeFile(root, 'apps/desktop/package-lock.json', JSON.stringify(desktopLock));
  // The real-binary test harness has its own manifest, so the pinned set is three.
  writeFile(root, 'e2e/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
  writeFile(root, 'Cargo.lock', 'version = 4\n');
  assert.doesNotThrow(() => assertLockfiles(root));

  rootLock.packages['node_modules/7zip-bin-full'].integrity = genericIntegrity;
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(rootLock));
  assert.throws(
    () => assertLockfiles(root),
    /must bind 7zip-bin-full to its reviewed registry artifact/,
  );

  rootLock.packages['node_modules/7zip-bin-full'].integrity =
    'sha512-h1DE4G8WEJ3/LI4HTcuOpouP7cy9JGqYfZm5fzLhdzw8jI3wFyA9RFu5MP+ICzelKEYmWweRWApEvVWKmJIdVQ==';
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(rootLock));
  writeFile(
    root,
    'Cargo.lock',
    `version = 4\n\n[[package]]\nname = "git-fixture"\nversion = "1.0.0"\nsource = "git+https://example.test/repository.git#${'a'.repeat(40)}"\n`,
  );
  assert.doesNotThrow(() => assertLockfiles(root));
  writeFile(
    root,
    'Cargo.lock',
    'version = 4\n\n[[package]]\nname = "git-fixture"\nversion = "1.0.0"\nsource = "git+https://example.test/repository.git#main"\n',
  );
  assert.throws(
    () => assertLockfiles(root),
    /git dependency git-fixture must use HTTPS and a full commit revision/,
  );
});

test('effective toolchain versions must equal every repository pin', () => {
  const pins = {
    nodeVersion: '24.19.0',
    packageManager: 'npm@11.17.0',
    pythonVersion: '3.12.10',
    rustVersion: '1.97.1',
  };
  assert.doesNotThrow(() =>
    assertEffectiveToolchain(pins, {
      nodeVersion: '24.19.0',
      npmVersion: '11.17.0',
      pythonVersion: '3.12.10',
      rustVersion: '1.97.1',
    }),
  );
  assert.throws(
    () =>
      assertEffectiveToolchain(pins, {
        nodeVersion: '24.19.0',
        npmVersion: '11.16.0',
        pythonVersion: '3.12.10',
        rustVersion: '1.97.1',
      }),
    /Effective npm is 11\.16\.0/,
  );
  assert.throws(
    () =>
      assertEffectiveToolchain(pins, {
        nodeVersion: '24.19.0',
        npmVersion: '11.17.0',
        pythonVersion: '3.12.9',
        rustVersion: '1.97.1',
      }),
    /Effective Python is 3\.12\.9/,
  );
});
