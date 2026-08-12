const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createHash,
  generateKeyPairSync,
  sign,
} = require('node:crypto');

const {
  assertArtifactArchitecture,
  assertExactResourceCopies,
  assertResourceCopiesBySuffix,
  assertSafeArtifact,
  assertSevenZipFormatSupport,
  assertUpdaterSignatureMode,
  assertWindowsMainExecutableArchitecture,
  parseArguments,
  pathEndsWith,
  readElfArchitecture,
  readMachCpuTypes,
  readPeMachine,
  validateReleaseArtifacts,
  verifyUpdaterSignature,
} = require('./check-release-artifacts');

function createUpdaterSignatureFixture(root) {
  const artifact = writeFile(root, 'installer.exe', 'signed installer bytes');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const rawPublicKey = publicDer.subarray(-32);
  const keyId = createHash('sha256').update(rawPublicKey).digest().subarray(0, 8);
  const publicPayload = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);
  const artifactDigest = createHash('blake2b512').update(fs.readFileSync(artifact)).digest();
  const artifactSignature = sign(null, artifactDigest, privateKey);
  const trustedComment = 'timestamp:1786451200\tfile:installer.exe';
  const globalSignature = sign(
    null,
    Buffer.concat([artifactSignature, Buffer.from(trustedComment)]),
    privateKey,
  );
  const signatureEnvelope = [
    'untrusted comment: signature from test key',
    Buffer.concat([Buffer.from('ED'), keyId, artifactSignature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
  const signaturePath = writeFile(root, 'installer.exe.sig', Buffer.from(signatureEnvelope).toString('base64'));
  const publicEnvelope = [
    'untrusted comment: minisign public key test',
    publicPayload.toString('base64'),
    '',
  ].join('\n');
  return {
    artifact,
    encodedPublicKey: Buffer.from(publicEnvelope).toString('base64'),
    signaturePath,
  };
}

function writeFile(root, relativePath, contents = 'fixture') {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return absolutePath;
}

function createMacArtifactFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-release-artifacts-'));
  const sourceAbsolute = writeFile(root, 'vendor/osg_worker.py', 'trusted worker bytes');
  writeFile(
    root,
    'apps/desktop/src-tauri/tauri.conf.json',
    JSON.stringify({
      bundle: {
        resources: {
          '../../../vendor/osg_worker.py': 'workers/osg_worker.py',
        },
      },
    }),
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/Cargo.toml',
    '[package]\nname = "osg-desktop"\ndefault-run = "osg-desktop"\n',
  );
  const application =
    'target/aarch64-apple-darwin/release/bundle/macos/One-Click Subtitles Generator.app';
  const executable = writeFile(
    root,
    `${application}/Contents/MacOS/osg-desktop`,
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]),
  );
  fs.chmodSync(executable, 0o755);
  writeFile(
    root,
    `${application}/Contents/Resources/workers/osg_worker.py`,
    fs.readFileSync(sourceAbsolute),
  );
  return root;
}

test('parses only native bundle types for the selected target', () => {
  assert.deepEqual(
    parseArguments([
      '--target',
      'x86_64-unknown-linux-gnu',
      '--bundles',
      'appimage,deb',
    ]),
    {
      allowUnsigned: false,
      bundleNames: ['appimage', 'deb'],
      target: 'x86_64-unknown-linux-gnu',
      targetDirectory: 'target',
    },
  );
  assert.deepEqual(
    parseArguments([
      '--target',
      'x86_64-pc-windows-msvc',
      '--bundles',
      'nsis',
      '--allow-unsigned-branch-build',
    ]),
    {
      allowUnsigned: true,
      bundleNames: ['nsis'],
      target: 'x86_64-pc-windows-msvc',
      targetDirectory: 'target',
    },
  );
  assert.throws(
    () =>
      parseArguments([
        '--target',
        'x86_64-pc-windows-msvc',
        '--bundles',
        'dmg',
      ]),
    /not a native bundle/,
  );
});

test('validates macOS app structure and byte-exact packaged resources', (context) => {
  const root = createMacArtifactFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const report = validateReleaseArtifacts({
    rootDirectory: root,
    target: 'aarch64-apple-darwin',
    bundleNames: ['app'],
  });
  assert.equal(report.artifactCount, 1);
  assert.equal(report.resourceCount, 1);
});

test('rejects a packaged resource whose bytes drifted', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-release-resource-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sourceAbsolute = writeFile(root, 'source/worker.py', 'expected');
  writeFile(root, 'package/workers/worker.py', 'tampered');
  assert.throws(
    () =>
      assertExactResourceCopies(path.join(root, 'package'), [
        {
          destination: 'workers/worker.py',
          sourceAbsolute,
        },
      ]),
    /differs from its locked source/,
  );
});

test('cryptographically verifies the updater artifact, signature, and trusted comment', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-updater-signature-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const fixture = createUpdaterSignatureFixture(root);

  assert.doesNotThrow(() => verifyUpdaterSignature(
    fixture.artifact,
    fixture.signaturePath,
    fixture.encodedPublicKey,
  ));
  fs.appendFileSync(fixture.artifact, 'tampered');
  assert.throws(
    () => verifyUpdaterSignature(
      fixture.artifact,
      fixture.signaturePath,
      fixture.encodedPublicKey,
    ),
    /does not authenticate/,
  );
});

test('unsigned branch validation is explicit and rejects a stale signature sidecar', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-unsigned-branch-artifact-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const artifact = writeFile(root, 'installer.exe', Buffer.from('unsigned branch artifact'));
  assert.doesNotThrow(() => assertUpdaterSignatureMode(artifact, { allowUnsigned: true, rootDirectory: root }));
  writeFile(root, 'installer.exe.sig', 'stale-signature');
  assert.throws(
    () => assertUpdaterSignatureMode(artifact, { allowUnsigned: true, rootDirectory: root }),
    /must not accept or ignore a signature sidecar/,
  );
});

test('rejects updater signatures from another key and malformed outer envelopes', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-updater-key-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const first = createUpdaterSignatureFixture(path.join(root, 'first'));
  const second = createUpdaterSignatureFixture(path.join(root, 'second'));

  assert.throws(
    () => verifyUpdaterSignature(first.artifact, first.signaturePath, second.encodedPublicKey),
    /key ID does not match/,
  );
  assert.throws(
    () => verifyUpdaterSignature(first.artifact, first.signaturePath, `${first.encodedPublicKey}\nA`),
    /canonical base64/,
  );
});

test('finds Linux resources only on complete destination suffixes', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-linux-resource-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sourceAbsolute = writeFile(root, 'source/worker.py', 'expected');
  writeFile(root, 'extracted/usr/lib/osg/workers/worker.py', 'expected');
  assert.doesNotThrow(() =>
    assertResourceCopiesBySuffix(path.join(root, 'extracted'), [
      { destination: 'workers/worker.py', sourceAbsolute },
    ]),
  );
  assert.equal(pathEndsWith('usr/lib/osg/not-workers/worker.py', 'workers/worker.py'), false);
});

test('rejects ambiguous duplicate resource destinations inside a package', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-duplicate-resource-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sourceAbsolute = writeFile(root, 'source/worker.py', 'expected');
  writeFile(root, 'extracted/first/workers/worker.py', 'expected');
  writeFile(root, 'extracted/second/workers/worker.py', 'expected');
  assert.throws(
    () => assertResourceCopiesBySuffix(path.join(root, 'extracted'), [
      { destination: 'workers/worker.py', sourceAbsolute },
    ]),
    /exactly one resource destination/,
  );
});

test('rejects empty package artifacts', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-empty-artifact-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const artifact = writeFile(root, 'empty.exe', '');
  assert.throws(() => assertSafeArtifact(artifact, 'file'), /empty or invalid/);
});

test('rejects a non-empty installer with the wrong container signature', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-invalid-installer-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const artifact = writeFile(root, 'installer.exe', 'not a PE executable');
  assert.throws(() => assertSafeArtifact(artifact, 'file'), /no PE\/NSIS signature/);
});

test('requires full 7-Zip NSIS and PE inspection capabilities', () => {
  const complete = [
    'Formats:',
    '  C K          Nsis     nsis           M Z',
    '  C K          PE       exe dll sys    M Z',
  ].join('\n');
  assert.doesNotThrow(() => assertSevenZipFormatSupport(complete));
  assert.throws(
    () => assertSevenZipFormatSupport('Formats:\n  C K          PE       exe'),
    /does not advertise NSIS/,
  );
  assert.throws(
    () => assertSevenZipFormatSupport('Formats:\n  C K          Nsis     nsis'),
    /does not advertise PE/,
  );
  assert.throws(
    () => assertSevenZipFormatSupport('7-Zip supports Nsis and PE inspection'),
    /did not report its supported formats/,
  );
});

test('parses PE, ELF, and Mach-O architecture headers without executing payloads', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-artifact-architecture-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const pe = Buffer.alloc(0x46);
  pe.write('MZ', 0, 'ascii');
  pe.writeUInt32LE(0x40, 0x3c);
  pe.write('PE\0\0', 0x40, 'binary');
  pe.writeUInt16LE(0x8664, 0x44);
  const pePath = writeFile(root, 'payload.exe', pe);
  assert.equal(readPeMachine(pePath), 0x8664);

  const elf = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(0x3e, 18);
  const elfPath = writeFile(root, 'payload.AppImage', elf);
  fs.chmodSync(elfPath, 0o755);
  assert.deepEqual(readElfArchitecture(elfPath), { bits: 64, machine: 0x3e });
  assert.doesNotThrow(() =>
    assertArtifactArchitecture(elfPath, 'x86_64-unknown-linux-gnu'),
  );

  const machPath = writeFile(
    root,
    'payload',
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]),
  );
  assert.deepEqual([...readMachCpuTypes(machPath)], [0x0100000c]);

  elf.writeUInt16LE(0xb7, 18);
  fs.writeFileSync(elfPath, elf);
  assert.throws(
    () => assertArtifactArchitecture(elfPath, 'x86_64-unknown-linux-gnu'),
    /architecture does not match/,
  );
});

test('rejects a wrong-architecture NSIS main executable even beside an x64 helper', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-nsis-main-architecture-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const pe = (machine) => {
    const buffer = Buffer.alloc(0x46);
    buffer.write('MZ', 0, 'ascii');
    buffer.writeUInt32LE(0x40, 0x3c);
    Buffer.from('PE\0\0', 'binary').copy(buffer, 0x40);
    buffer.writeUInt16LE(machine, 0x44);
    return buffer;
  };
  writeFile(root, 'app/osg-desktop.exe', pe(0x014c));
  writeFile(root, 'app/helper.exe', pe(0x8664));
  assert.throws(
    () => assertWindowsMainExecutableArchitecture(
      root,
      'osg-desktop.exe',
      'x86_64-pc-windows-msvc',
    ),
    /main executable osg-desktop\.exe does not match/,
  );

  writeFile(root, 'app/osg-desktop.exe', pe(0x8664));
  assert.doesNotThrow(() => assertWindowsMainExecutableArchitecture(
    root,
    'osg-desktop.exe',
    'x86_64-pc-windows-msvc',
  ));
});

test('artifact target directories may not escape the repository', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-artifact-root-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.throws(
    () =>
      validateReleaseArtifacts({
        rootDirectory: root,
        target: 'x86_64-pc-windows-msvc',
        bundleNames: ['nsis'],
        targetDirectory: path.resolve(root, '..', 'outside'),
      }),
    /must stay inside the repository/,
  );
});
