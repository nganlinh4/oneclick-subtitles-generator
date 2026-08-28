import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectInstallerPayload, parseArguments } from './inspect-installer-payload.mjs';

const digestOf = (contents) => createHash('sha256').update(contents).digest('hex');

/**
 * A miniature repository carrying exactly what `apps/desktop/src-tauri/tauri.conf.json` really
 * declares (two workers, two licences, one managed font) plus the source-of-truth files
 * `scripts/check-version-consistency.js` and `scripts/check-release-artifacts.js` read.
 */
function buildFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-installer-payload-repo-'));
  const tauriDir = path.join(root, 'apps', 'desktop', 'src-tauri');
  const fontsDir = path.join(tauriDir, 'resources', 'ui-fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'crates', 'osg-asr', 'worker'), { recursive: true });
  fs.mkdirSync(path.join(root, 'crates', 'osg-speech', 'worker'), { recursive: true });
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT license text');
  fs.writeFileSync(
    path.join(root, 'THIRD_PARTY_NOTICES.md'),
    'This project ships the ASR worker and the root LICENSE.',
  );
  fs.writeFileSync(path.join(root, 'crates', 'osg-asr', 'worker', 'osg_asr_worker.py'), '# asr worker');
  fs.writeFileSync(path.join(root, 'crates', 'osg-speech', 'worker', 'osg_speech_worker.py'), '# speech worker');

  const fontDigest = digestOf('font-bytes');
  fs.writeFileSync(path.join(fontsDir, fontDigest), 'font-bytes');

  const resources = {
    '../../../crates/osg-asr/worker/osg_asr_worker.py': 'workers/osg_asr_worker.py',
    '../../../crates/osg-speech/worker/osg_speech_worker.py': 'workers/osg_speech_worker.py',
    '../../../LICENSE': 'licenses/LICENSE',
    '../../../THIRD_PARTY_NOTICES.md': 'licenses/THIRD_PARTY_NOTICES.md',
    [`resources/ui-fonts/${fontDigest}`]: `ui-fonts/${fontDigest}`,
  };
  fs.writeFileSync(path.join(tauriDir, 'tauri.conf.json'), JSON.stringify({
    productName: 'One-Click Subtitles Generator',
    version: '1.0.0',
    bundle: { resources },
  }));

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'),
    JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  fs.mkdirSync(path.join(root, 'apps', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'),
    JSON.stringify({ version: '1.0.0', packageManager: 'npm@10.0.0' }));
  fs.writeFileSync(path.join(root, 'apps', 'desktop', 'package-lock.json'),
    JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[workspace.package]\nversion = "1.0.0"\n');
  fs.writeFileSync(path.join(tauriDir, 'Cargo.toml'),
    '[package]\nname = "osg-desktop"\ndefault-run = "osg-desktop"\nversion.workspace = true\n');
  fs.writeFileSync(path.join(root, '.node-version'), '22.0.0');

  return { fontDigest, root };
}

function buildPassingPayload(fontDigest) {
  const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-installer-payload-fixture-'));
  fs.writeFileSync(path.join(payload, 'osg-desktop.exe'), 'MZ-fake-exe');
  fs.mkdirSync(path.join(payload, 'workers'));
  fs.writeFileSync(path.join(payload, 'workers', 'osg_asr_worker.py'), '# asr worker');
  fs.writeFileSync(path.join(payload, 'workers', 'osg_speech_worker.py'), '# speech worker');
  fs.mkdirSync(path.join(payload, 'licenses'));
  fs.writeFileSync(path.join(payload, 'licenses', 'LICENSE'), 'MIT license text');
  fs.writeFileSync(
    path.join(payload, 'licenses', 'THIRD_PARTY_NOTICES.md'),
    'This project ships the ASR worker and the root LICENSE.',
  );
  fs.mkdirSync(path.join(payload, 'ui-fonts'));
  fs.writeFileSync(path.join(payload, 'ui-fonts', fontDigest), 'font-bytes');
  return payload;
}

function fakeHelpers() {
  return {
    applicationBinaryBaseName: () => 'osg-desktop',
    assertAllVersionsMatch: (versions) => versions[0].version,
    assertWindowsMainExecutableArchitecture: () => {},
    collectRepositoryVersions: () => ({ versions: [{ name: 'fixture', version: '1.0.0' }] }),
    collectResourceMappings: (rootDirectory) => {
      const configPath = path.join(rootDirectory, 'apps/desktop/src-tauri/tauri.conf.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return Object.entries(config.bundle.resources).map(([source, destination]) => ({
        destination,
        source,
        sourceAbsolute: path.resolve(path.join(rootDirectory, 'apps/desktop/src-tauri'), source),
      }));
    },
    sha256File: (filePath) => digestOf(fs.readFileSync(filePath)),
  };
}

const passingVersionInfo = () => ({
  CompanyName: null,
  FileDescription: null,
  FileVersion: '1.0.0.0',
  InternalName: null,
  LegalCopyright: null,
  OriginalFilename: null,
  ProductName: 'One-Click Subtitles Generator',
  ProductVersion: '1.0.0.0',
});

/** Builds a fresh passing repo + payload pair, runs `callback`, then always cleans up both. */
async function withScenario(callback) {
  const { fontDigest, root } = buildFixtureRoot();
  const payload = buildPassingPayload(fontDigest);
  try {
    return await callback({ fontDigest, payload, root });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(payload, { force: true, recursive: true });
  }
}

function runInspection(root, payload, overrides = {}) {
  return inspectInstallerPayload({
    e2eReferenceDirectory: null,
    helpers: fakeHelpers(),
    payloadDirectory: payload,
    readVersionInfo: passingVersionInfo,
    rootDirectory: root,
    ...overrides,
  });
}

test('a synthetic reviewed payload passes with no violations', () => withScenario(async ({ payload, root }) => {
  const report = await runInspection(root, payload);
  assert.equal(report.pass, true);
  assert.deepEqual(report.violations, []);
  assert.equal(report.resources.verified, 5);
  assert.equal(report.topLevelShape.matches, true);
  assert.deepEqual(report.topLevelShape.actual, ['licenses', 'osg-desktop.exe', 'ui-fonts', 'workers']);
}));

test('fails precisely on a bundled Electron artifact', () => withScenario(async ({ payload, root }) => {
  fs.writeFileSync(path.join(payload, 'electron.exe'), 'MZ-fake-electron');
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.equal(report.residue.rulesMatched, 1);
  assert.equal(report.residue.violations[0].path, 'electron.exe');
  assert.match(report.residue.violations[0].reason, /Electron/);
  assert.ok(report.violations.some((line) => line.includes('electron.exe') && line.includes('Electron')));
}));

test('fails precisely on a bundled Node runtime executable', () => withScenario(async ({ payload, root }) => {
  fs.mkdirSync(path.join(payload, 'bin'));
  fs.writeFileSync(path.join(payload, 'bin', 'node.exe'), 'MZ-fake-node');
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.equal(report.residue.violations.length, 1);
  assert.match(report.residue.violations[0].reason, /Node\.js runtime/);
}));

test('fails precisely on a bundled Chromium/CEF payload fragment', () => withScenario(async ({ payload, root }) => {
  fs.writeFileSync(path.join(payload, 'icudtl.dat'), 'fake-icu-table');
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.match(report.residue.violations[0].reason, /ICU data table/);
}));

test('fails on a missing required resource', () => withScenario(async ({ payload, root }) => {
  fs.rmSync(path.join(payload, 'workers', 'osg_asr_worker.py'));
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.equal(report.resources.verified, 4);
  assert.ok(report.violations.some((line) => line.includes('Missing packaged resource: workers/osg_asr_worker.py')));
}));

test('fails on a resource whose bytes were substituted', () => withScenario(async ({ payload, root }) => {
  fs.writeFileSync(path.join(payload, 'licenses', 'LICENSE'), 'a different license entirely');
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.ok(report.violations.some((line) => line.includes('differs from its locked source: licenses/LICENSE')));
}));

test('reports a license file the notices document never accounts for', () => withScenario(async ({ payload, root }) => {
  fs.writeFileSync(path.join(payload, 'licenses', 'COPYING'), 'GPL-3.0-or-later');
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.deepEqual(report.notices.gaps, ['licenses/COPYING']);
  assert.ok(report.violations.some((line) => line.includes('licenses/COPYING')
    && line.includes('THIRD_PARTY_NOTICES.md mention')));
}));

test('accepts a license file the notices document does mention by name', () => withScenario(async ({ payload, root }) => {
  fs.writeFileSync(path.join(payload, 'licenses', 'NOTICE'), 'a notice');
  fs.appendFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), '\nAlso see NOTICE.');
  const report = await runInspection(root, payload);
  assert.deepEqual(report.notices.gaps, []);
  assert.ok(report.notices.accounted.includes('licenses/NOTICE'));
}));

test('fails when the payload top level carries an unexpected extra entry', () => withScenario(async ({ payload, root }) => {
  fs.writeFileSync(path.join(payload, 'extra-file.txt'), 'unexpected');
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.equal(report.topLevelShape.matches, false);
  assert.deepEqual(report.topLevelShape.extra, ['extra-file.txt']);
  assert.ok(report.violations.some((line) => line.includes('unexpected entry: extra-file.txt')));
}));

test('fails when the payload top level is missing a declared resource directory', () => withScenario(async ({ payload, root }) => {
  fs.rmSync(path.join(payload, 'ui-fonts'), { force: true, recursive: true });
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.ok(report.topLevelShape.missing.includes('ui-fonts'));
}));

test('fails when tauri.conf.json declares a bundle.externalBin sidecar', () => withScenario(async ({ payload, root }) => {
  const configPath = path.join(root, 'apps/desktop/src-tauri/tauri.conf.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.bundle.externalBin = ['bin/some-tool'];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const report = await runInspection(root, payload);
  assert.equal(report.pass, false);
  assert.equal(report.externalBin.ok, false);
  assert.ok(report.violations.some((line) => line.includes('bundle.externalBin')));
}));

test('fails when the shipped executable version metadata disagrees with the repository version', () => withScenario(async ({ payload, root }) => {
  const report = await runInspection(root, payload, {
    readVersionInfo: () => ({ ...passingVersionInfo(), FileVersion: '9.9.9.0' }),
  });
  assert.equal(report.pass, false);
  assert.ok(report.violations.some((line) => line.includes('FileVersion 9.9.9.0 does not match 1.0.0')));
}));

test('fails when the shipped executable product name has drifted', () => withScenario(async ({ payload, root }) => {
  const report = await runInspection(root, payload, {
    readVersionInfo: () => ({ ...passingVersionInfo(), ProductName: 'Subtitles Generator (Electron)' }),
  });
  assert.equal(report.pass, false);
  assert.ok(report.violations.some((line) => line.includes('ProductName')));
}));

test('cross-checks a supplied e2e reference publication and reports a mismatch', () => withScenario(async ({ fontDigest, payload, root }) => {
  const reference = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-reference-'));
  try {
    fs.writeFileSync(path.join(reference, 'osg-desktop.exe'), 'MZ');
    fs.mkdirSync(path.join(reference, 'workers'));
    fs.mkdirSync(path.join(reference, 'licenses'));
    // Deliberately missing ui-fonts/, unlike the real e2e publication this stands in for.
    fs.writeFileSync(path.join(reference, '.osg-application-manifest.json'), '{}');
    const report = await runInspection(root, payload, { e2eReferenceDirectory: reference });
    assert.equal(report.e2eCrossCheck.performed, true);
    assert.equal(report.e2eCrossCheck.matches, false);
    assert.deepEqual(report.e2eCrossCheck.missing, ['ui-fonts']);
    assert.equal(report.pass, false);
  } finally {
    fs.rmSync(reference, { force: true, recursive: true });
  }
}));

test('cross-checks a matching e2e reference publication and passes', () => withScenario(async ({ fontDigest, payload, root }) => {
  const reference = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-reference-'));
  try {
    fs.writeFileSync(path.join(reference, 'osg-desktop.exe'), 'MZ');
    fs.mkdirSync(path.join(reference, 'workers'));
    fs.mkdirSync(path.join(reference, 'licenses'));
    fs.mkdirSync(path.join(reference, 'ui-fonts'));
    fs.writeFileSync(path.join(reference, '.osg-application-manifest.json'), '{}');
    const report = await runInspection(root, payload, { e2eReferenceDirectory: reference });
    assert.equal(report.e2eCrossCheck.performed, true);
    assert.equal(report.e2eCrossCheck.matches, true);
    assert.equal(report.pass, true);
  } finally {
    fs.rmSync(reference, { force: true, recursive: true });
  }
}));

test('skipping the e2e cross-check is reported, not silently ignored, and still passes', () => withScenario(async ({ payload, root }) => {
  const report = await runInspection(root, payload);
  assert.equal(report.e2eCrossCheck.performed, false);
  assert.equal(typeof report.e2eCrossCheck.reason, 'string');
  assert.equal(report.pass, true);
}));

test('rejects a payload directory that does not exist', () => withScenario(async ({ root }) => {
  await assert.rejects(
    () => runInspection(root, path.join(root, 'does-not-exist')),
    /Payload directory does not exist/,
  );
}));

test('rejects being given neither an installer nor a payload directory', async () => {
  await assert.rejects(
    () => inspectInstallerPayload({ helpers: fakeHelpers() }),
    /Provide exactly one of an installer path or a pre-extracted payload directory/,
  );
});

test('rejects being given both an installer and a payload directory', async () => {
  await assert.rejects(
    () => inspectInstallerPayload({
      helpers: fakeHelpers(),
      installerPath: 'C:/fake/setup.exe',
      payloadDirectory: 'C:/fake/payload',
    }),
    /Provide exactly one of an installer path or a pre-extracted payload directory/,
  );
});

test('parseArguments requires exactly one of --installer or --payload-dir', () => {
  assert.throws(() => parseArguments([]), /Usage: inspect-installer-payload\.mjs/);
  assert.throws(
    () => parseArguments(['--installer', 'a.exe', '--payload-dir', 'b']),
    /Provide only one of --installer or --payload-dir/,
  );
});

test('parseArguments rejects an unknown flag', () => {
  assert.throws(() => parseArguments(['--payload-dir', 'b', '--bogus', 'x']), /Unknown argument: --bogus/);
});

test('parseArguments accepts a full option set, including an explicit "none" e2e reference', () => {
  const options = parseArguments([
    '--installer', 'C:/build/setup.exe',
    '--root', 'C:/repo',
    '--e2e-reference', 'none',
    '--json-out', 'C:/out/report.json',
  ]);
  assert.equal(options.installerPath, 'C:/build/setup.exe');
  assert.equal(options.rootDirectory, 'C:/repo');
  assert.equal(options.e2eReferenceDirectory, null);
  assert.equal(options.jsonOut, 'C:/out/report.json');
});

test('parseArguments leaves e2e-reference auto-discovery on by default', () => {
  const options = parseArguments(['--payload-dir', 'C:/extracted']);
  assert.equal(options.e2eReferenceDirectory, undefined);
  assert.equal(options.jsonOut, null);
});
