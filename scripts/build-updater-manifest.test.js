const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');

const {
  UPDATER_PLATFORMS,
  USAGE,
  buildManifest,
  collectPlatforms,
  locateSignedArtifact,
  main,
  parseArguments,
  platformBundleDirectory,
  redactLocations,
  resolveRepositoryVersion,
  serializeManifest,
} = require('./build-updater-manifest');

const PLATFORM = 'windows-x86_64-nsis';
const INSTALLER_NAME = 'One-Click Subtitles Generator_1.0.0_x64-setup.exe';
const BASE_URL = 'https://example.invalid/releases/download/v1.0.0/';
const PUB_DATE = '2026-08-15T00:00:00.000Z';
const VERSION = '1.0.0';

// Disposable Minisign-shaped key material, generated per test run and never
// written outside the temporary fixture root.
function createDisposableSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = createHash('sha256').update(rawPublicKey).digest().subarray(0, 8);
  const publicEnvelope = [
    'untrusted comment: minisign public key test',
    Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]).toString('base64'),
    '',
  ].join('\n');
  return {
    encodedPublicKey: Buffer.from(publicEnvelope).toString('base64'),
    sign(artifactBytes, fileName) {
      const digest = createHash('blake2b512').update(artifactBytes).digest();
      const artifactSignature = sign(null, digest, privateKey);
      const trustedComment = `timestamp:1786451200\tfile:${fileName}`;
      const globalSignature = sign(
        null,
        Buffer.concat([artifactSignature, Buffer.from(trustedComment)]),
        privateKey,
      );
      const envelope = [
        'untrusted comment: signature from test key',
        Buffer.concat([Buffer.from('ED'), keyId, artifactSignature]).toString('base64'),
        `trusted comment: ${trustedComment}`,
        globalSignature.toString('base64'),
        '',
      ].join('\n');
      return Buffer.from(envelope).toString('base64');
    },
  };
}

function installerBytes(suffix = '') {
  return Buffer.concat([Buffer.from('MZ'), Buffer.from(`nsis installer payload${suffix}`)]);
}

// Mirrors every version source `check-version-consistency` reads, so the CLI
// resolves a repository version from the fixture instead of the real checkout.
function writeRepositoryMetadata(root, encodedPublicKey) {
  const lockfile = { version: VERSION, packages: { '': { version: VERSION } } };
  const files = {
    'package.json': JSON.stringify({ version: VERSION }),
    'package-lock.json': JSON.stringify(lockfile),
    '.node-version': '24.19.0\n',
    'Cargo.toml': `[workspace.package]\nversion = "${VERSION}"\n`,
    'apps/desktop/package.json': JSON.stringify({ version: VERSION, packageManager: 'npm@11.6.2' }),
    'apps/desktop/package-lock.json': JSON.stringify(lockfile),
    'apps/desktop/src-tauri/Cargo.toml': '[package]\nname = "osg-desktop"\nversion.workspace = true\n',
    'apps/desktop/src-tauri/tauri.conf.json': JSON.stringify({
      version: VERSION,
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: encodedPublicKey } },
    }),
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
  }
}

function createFixture(context, { signerForSidecar, appendAfterSigning = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-updater-manifest-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const signer = createDisposableSigner();
  writeRepositoryMetadata(root, signer.encodedPublicKey);

  const directory = platformBundleDirectory(root, PLATFORM);
  fs.mkdirSync(directory, { recursive: true });
  const artifact = path.join(directory, INSTALLER_NAME);
  const signedBytes = installerBytes();
  fs.writeFileSync(artifact, signedBytes);
  fs.writeFileSync(
    `${artifact}.sig`,
    (signerForSidecar ?? signer).sign(signedBytes, INSTALLER_NAME),
  );
  if (appendAfterSigning) {
    fs.appendFileSync(artifact, appendAfterSigning);
  }

  return { artifact, bundleRoot: root, directory, root, signer };
}

function manifestInput(overrides = {}) {
  return {
    version: VERSION,
    notes: 'Signed release',
    pub_date: PUB_DATE,
    platforms: {
      [PLATFORM]: {
        signature: Buffer.from('minisign envelope').toString('base64'),
        url: `${BASE_URL}osg-setup.exe`,
      },
    },
    ...overrides,
  };
}

test('happy path verifies the signed installer and emits canonical manifest bytes', (context) => {
  const fixture = createFixture(context);
  const platforms = collectPlatforms({
    bundleRoot: fixture.bundleRoot,
    platformKeys: [PLATFORM],
    baseUrl: BASE_URL,
    rootDirectory: fixture.root,
  });

  assert.deepEqual(Object.keys(platforms), [PLATFORM]);
  assert.equal(
    platforms[PLATFORM].url,
    `${BASE_URL}${encodeURIComponent(INSTALLER_NAME)}`,
  );
  assert.equal(
    platforms[PLATFORM].signature,
    fs.readFileSync(`${fixture.artifact}.sig`, 'utf8').trim(),
  );

  const manifest = buildManifest(
    manifestInput({ platforms }),
    { repositoryVersion: VERSION },
  );
  assert.deepEqual(Object.keys(manifest), ['version', 'notes', 'pub_date', 'platforms']);
  assert.deepEqual(Object.keys(manifest.platforms[PLATFORM]), ['signature', 'url']);

  const bytes = serializeManifest(manifest);
  assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'manifest must have no BOM');
  assert.deepEqual(bytes, Buffer.from(bytes.toString('utf8'), 'utf8'));
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), {
    version: VERSION,
    notes: 'Signed release',
    pub_date: PUB_DATE,
    platforms: {
      [PLATFORM]: {
        signature: platforms[PLATFORM].signature,
        url: platforms[PLATFORM].url,
      },
    },
  });
});

test('an installer without a .sig sidecar is rejected before anything is emitted', (context) => {
  const fixture = createFixture(context);
  fs.rmSync(`${fixture.artifact}.sig`);

  assert.throws(
    () => collectPlatforms({
      bundleRoot: fixture.bundleRoot,
      platformKeys: [PLATFORM],
      baseUrl: BASE_URL,
      rootDirectory: fixture.root,
    }),
    /has no \.sig sidecar/,
  );
});

test('a signature produced by a different key is rejected', (context) => {
  const foreign = createDisposableSigner();
  const fixture = createFixture(context, { signerForSidecar: foreign });

  assert.throws(
    () => locateSignedArtifact({
      bundleRoot: fixture.bundleRoot,
      platformKey: PLATFORM,
      rootDirectory: fixture.root,
    }),
    /key ID does not match|does not authenticate/,
  );
});

test('bytes appended after signing invalidate the artifact', (context) => {
  const fixture = createFixture(context, { appendAfterSigning: 'tampered tail' });

  assert.throws(
    () => locateSignedArtifact({
      bundleRoot: fixture.bundleRoot,
      platformKey: PLATFORM,
      rootDirectory: fixture.root,
    }),
    /does not authenticate/,
  );
});

test('zero and ambiguous installers both fail the uniqueness rule', (context) => {
  const fixture = createFixture(context);
  const second = path.join(fixture.directory, 'Another_1.0.0_x64-setup.exe');
  fs.copyFileSync(fixture.artifact, second);
  fs.copyFileSync(`${fixture.artifact}.sig`, `${second}.sig`);
  assert.throws(
    () => locateSignedArtifact({
      bundleRoot: fixture.bundleRoot,
      platformKey: PLATFORM,
      rootDirectory: fixture.root,
    }),
    /Expected exactly one windows-x86_64-nsis installer, found 2/,
  );

  fs.rmSync(second);
  fs.rmSync(`${second}.sig`);
  fs.rmSync(fixture.artifact);
  assert.throws(
    () => locateSignedArtifact({
      bundleRoot: fixture.bundleRoot,
      platformKey: PLATFORM,
      rootDirectory: fixture.root,
    }),
    /Expected exactly one windows-x86_64-nsis installer, found 0/,
  );
});

test('a manifest version disagreeing with the repository version is rejected', () => {
  assert.throws(
    () => buildManifest(manifestInput({ version: '9.9.9' }), { repositoryVersion: VERSION }),
    /Manifest version 9\.9\.9 does not match the repository version 1\.0\.0/,
  );
  assert.throws(
    () => buildManifest(manifestInput(), { repositoryVersion: '2.0.0' }),
    /does not match the repository version 2\.0\.0/,
  );
  assert.throws(() => buildManifest(manifestInput()), /semantic repository version is required/);
});

test('non-HTTPS and credential-bearing urls are rejected', () => {
  for (const url of [
    'http://example.invalid/osg-setup.exe',
    'file:///c:/tmp/osg-setup.exe',
    'ftp://example.invalid/osg-setup.exe',
    'https://user:secret@example.invalid/osg-setup.exe',
  ]) {
    assert.throws(
      () => buildManifest(
        manifestInput({
          platforms: { [PLATFORM]: { signature: manifestInput().platforms[PLATFORM].signature, url } },
        }),
        { repositoryVersion: VERSION },
      ),
      /must use https|must not embed credentials/,
      `expected ${url} to be rejected`,
    );
  }

  assert.throws(
    () => collectPlatforms({
      bundleRoot: os.tmpdir(),
      platformKeys: [PLATFORM],
      baseUrl: 'http://example.invalid/releases/',
    }),
    /must use https/,
  );
});

test('unexpected, missing, and unknown-platform keys are rejected', () => {
  assert.throws(
    () => buildManifest({ ...manifestInput(), signature: 'extra' }, { repositoryVersion: VERSION }),
    /Manifest has an unexpected key "signature"/,
  );
  const { notes, ...withoutNotes } = manifestInput();
  assert.equal(typeof notes, 'string');
  assert.throws(
    () => buildManifest(withoutNotes, { repositoryVersion: VERSION }),
    /Manifest is missing the "notes" key/,
  );
  assert.throws(
    () => buildManifest(
      manifestInput({
        platforms: {
          [PLATFORM]: { ...manifestInput().platforms[PLATFORM], format: 'nsis' },
        },
      }),
      { repositoryVersion: VERSION },
    ),
    /Manifest platform windows-x86_64-nsis has an unexpected key "format"/,
  );
  assert.throws(
    () => buildManifest(
      manifestInput({ platforms: { 'windows-i686-nsis': manifestInput().platforms[PLATFORM] } }),
      { repositoryVersion: VERSION },
    ),
    /is not a released updater platform/,
  );
});

test('malformed signatures, notes, and timestamps are rejected', () => {
  const entry = manifestInput().platforms[PLATFORM];
  const reject = (platforms, pattern) =>
    assert.throws(
      () => buildManifest(manifestInput(platforms), { repositoryVersion: VERSION }),
      pattern,
    );

  reject({ platforms: { [PLATFORM]: { ...entry, signature: 'not base64!' } } }, /canonical base64/);
  reject({ platforms: { [PLATFORM]: { ...entry, signature: '' } } }, /is empty/);
  reject({ platforms: {} }, /at least one platform/);
  reject({ notes: `bad${String.fromCharCode(0)}notes` }, /control characters/);
  reject({ pub_date: '2026-08-15 00:00:00' }, /RFC 3339 UTC timestamp/);
  reject({ pub_date: '2026-13-45T00:00:00Z' }, /not a real instant/);
  reject({ version: '1.0' }, /not a semantic version/);
});

test('failure messages never disclose paths outside the requested bundle root', (context) => {
  const fixture = createFixture(context, { appendAfterSigning: 'tampered tail' });
  try {
    locateSignedArtifact({
      bundleRoot: fixture.bundleRoot,
      platformKey: PLATFORM,
      rootDirectory: fixture.root,
    });
    assert.fail('tampered artifact must not verify');
  } catch (error) {
    assert.ok(!error.message.includes(fixture.root), error.message);
    assert.ok(!error.message.includes(os.tmpdir()), error.message);
  }

  assert.equal(
    redactLocations('read C:\\stage\\bundle\\x.exe and C:/stage/bundle/y.sig', {
      bundleRoot: 'C:\\stage\\bundle',
      rootDirectory: 'C:\\repo',
    }),
    'read <bundle>\\x.exe and <bundle>/y.sig',
  );
});

test('the platform table matches the released bundle layouts and repository version', () => {
  assert.deepEqual(Object.keys(UPDATER_PLATFORMS).sort(), [
    'darwin-aarch64-app',
    'darwin-x86_64-app',
    'linux-x86_64-appimage',
    'windows-x86_64-nsis',
  ]);
  assert.match(resolveRepositoryVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(
    path.basename(platformBundleDirectory(path.join(os.tmpdir(), 'stage'), PLATFORM)),
    'nsis',
  );
});

test('argument parsing enforces required, unique, and known options', () => {
  const required = [
    '--bundle-root', 'stage',
    '--base-url', BASE_URL,
    '--platform', PLATFORM,
    '--notes', 'Signed release',
  ];
  assert.deepEqual(parseArguments(required), {
    help: false,
    bundleRoot: 'stage',
    baseUrl: BASE_URL,
    notes: 'Signed release',
    platformKeys: [PLATFORM],
  });
  assert.equal(parseArguments(['--help']).help, true);
  assert.throws(() => parseArguments([...required, '--notes', 'again']), /only be given once/);
  assert.throws(() => parseArguments([...required, '--secret']), /Unknown argument "--secret"/);
  assert.throws(() => parseArguments(['--base-url', BASE_URL]), /--bundle-root is required/);
  assert.throws(
    () => parseArguments([...required.slice(0, 4), '--platform', 'windows-i686-msi', '--notes', 'x']),
    /Unsupported updater platform/,
  );
});

test('the CLI writes the manifest inside the bundle root and refuses to escape it', (context) => {
  const fixture = createFixture(context);
  const logged = [];
  context.mock.method(console, 'log', (line) => logged.push(line));

  const argv = [
    '--bundle-root', fixture.bundleRoot,
    '--base-url', BASE_URL,
    '--platform', PLATFORM,
    '--notes', 'Signed release',
    '--pub-date', PUB_DATE,
    '--output', 'latest.json',
  ];
  main(argv, { rootDirectory: fixture.root });

  const written = fs.readFileSync(path.join(fixture.bundleRoot, 'latest.json'));
  assert.deepEqual(Object.keys(JSON.parse(written.toString('utf8'))), [
    'version',
    'notes',
    'pub_date',
    'platforms',
  ]);
  assert.ok(logged.some((line) => line.includes('latest.json') && line.includes('1 verified platforms')), logged.join('\n'));
  assert.ok(!written.toString('utf8').includes(fixture.root), 'manifest must not embed local paths');

  assert.throws(
    () => main([...argv.slice(0, -1), path.join('..', 'escaped.json')], { rootDirectory: fixture.root }),
    /must stay inside the requested bundle root/,
  );

  logged.length = 0;
  main(['--help']);
  assert.equal(logged.length, 1);
  assert.equal(logged[0], USAGE);
  assert.match(USAGE, /--bundle-root/);
});
