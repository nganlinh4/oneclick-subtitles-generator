const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  applicationHashForPayload,
  packageReceiptBytes,
  payloadInventory,
  publishInstallerPackageReceipt,
  readAndVerifyInstallerPackageReceipt,
} = require('./installer-package-receipt.js');
const { verifyUpdaterSignature } = require('./check-release-artifacts.js');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const makeSigningKey = (root) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = crypto.randomBytes(8);
  const minisignKey = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);
  const publicText = `untrusted comment: minisign public key: test\n${minisignKey.toString('base64')}\n`;
  const publicKeyPath = path.join(root, `test-${crypto.randomUUID()}.pub`);
  fs.writeFileSync(publicKeyPath, Buffer.from(publicText).toString('base64'));
  const sign = (bytes) => {
    const signature = crypto.sign(
      null,
      crypto.createHash('blake2b512').update(bytes).digest(),
      privateKey,
    );
    const primary = Buffer.concat([Buffer.from('ED'), keyId, signature]);
    const trustedComment = `timestamp:0\tfile:receipt.json\tprehashed`;
    const global = crypto.sign(
      null,
      Buffer.concat([signature, Buffer.from(trustedComment)]),
      privateKey,
    );
    const envelope = Buffer.from([
      'untrusted comment: signature from minisign secret key',
      primary.toString('base64'),
      `trusted comment: ${trustedComment}`,
      global.toString('base64'),
      '',
    ].join('\n'));
    return Buffer.from(envelope.toString('base64'));
  };
  return { publicKeyPath, sign };
};

const createFixture = (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-installer-receipt-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installerPath = path.join(root, 'installer.exe');
  const installedRoot = path.join(root, 'installed');
  const executablePath = path.join(installedRoot, 'osg-desktop.exe');
  const uninstallerPath = path.join(installedRoot, 'uninstall.exe');
  const workerDirectory = path.join(installedRoot, 'workers');
  fs.mkdirSync(workerDirectory, { recursive: true });
  fs.writeFileSync(installerPath, 'installer-for-current-source');
  fs.writeFileSync(executablePath, 'packaged-current-executable');
  fs.writeFileSync(uninstallerPath, 'generated-nsis-uninstaller');
  fs.writeFileSync(path.join(workerDirectory, 'worker.py'), 'print("worker")\n');
  const trusted = makeSigningKey(root);
  const payloadContract = [
    { path: 'osg-desktop.exe', type: 'file' },
    { path: 'uninstall.exe', type: 'file' },
    { path: 'workers', type: 'directory' },
    { path: 'workers/worker.py', type: 'file' },
  ];
  return {
    root, installerPath, installedRoot, executablePath, trusted, payloadContract,
  };
};

const makeReceipt = ({ installerPath, executablePath, payloadContract, source = null }) => {
  const payloadEntries = payloadInventory(executablePath, payloadContract);
  const executable = payloadEntries.find(({ path: portable }) => portable === 'osg-desktop.exe');
  return {
    source: source ?? { commit: '1'.repeat(40), tree: '2'.repeat(40), dirty: false },
    applicationHash: applicationHashForPayload(payloadEntries),
    payloadEntries,
    payloadExecutableSha256: executable.sha256,
    installerSha256: digest(fs.readFileSync(installerPath)),
  };
};

const writeSignedReceipt = ({ root, receipt, signer }) => {
  const receiptPath = path.join(root, `receipt-${crypto.randomUUID()}.json`);
  const bytes = packageReceiptBytes(receipt);
  fs.writeFileSync(receiptPath, bytes);
  fs.writeFileSync(`${receiptPath}.sig`, signer.sign(bytes));
  return receiptPath;
};

const verify = (fixture, receiptPath, overrides = {}) => readAndVerifyInstallerPackageReceipt({
  receiptPath,
  installerPath: fixture.installerPath,
  installedExecutablePath: fixture.executablePath,
  publicKeyPath: fixture.trusted.publicKeyPath,
  payloadContract: fixture.payloadContract,
  ...overrides,
});

test('a signed receipt binds the installer and the complete installed tree', (context) => {
  const fixture = createFixture(context);
  const receipt = makeReceipt(fixture);
  const receiptPath = writeSignedReceipt({
    root: fixture.root, receipt, signer: fixture.trusted,
  });
  const verified = verify(fixture, receiptPath);
  assert.equal(verified.source.commit, '1'.repeat(40));
  assert.ok(verified.payloadEntries.some(({ path: portable }) => portable === 'uninstall.exe'));
  assert.match(verified.receiptSignatureSha256, /^[0-9a-f]{64}$/u);
  assert.doesNotThrow(() => verifyUpdaterSignature(
    receiptPath,
    `${receiptPath}.sig`,
    fs.readFileSync(fixture.trusted.publicKeyPath, 'utf8'),
  ));

  const foreignInstaller = path.join(fixture.root, 'foreign-installer.exe');
  fs.writeFileSync(foreignInstaller, 'same-version-foreign-installer');
  assert.throws(() => verify(fixture, receiptPath, { installerPath: foreignInstaller }), /does not match/u);
});

test('arbitrary files and empty directories cannot hide outside the receipt', (context) => {
  const fixture = createFixture(context);
  const receiptPath = writeSignedReceipt({
    root: fixture.root,
    receipt: makeReceipt(fixture),
    signer: fixture.trusted,
  });
  fs.writeFileSync(path.join(fixture.installedRoot, 'unexpected.dll'), 'unreviewed');
  assert.throws(() => verify(fixture, receiptPath), /does not match/u);
  fs.rmSync(path.join(fixture.installedRoot, 'unexpected.dll'));
  fs.mkdirSync(path.join(fixture.installedRoot, 'unexpected-empty'));
  assert.throws(() => verify(fixture, receiptPath), /does not match/u);
});

test('the installed root, nested entries, and regular files cannot be redirected or hard-linked', (context) => {
  const fixture = createFixture(context);
  const redirectedRoot = path.join(fixture.root, 'redirected-installed');
  fs.symlinkSync(
    fixture.installedRoot,
    redirectedRoot,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => payloadInventory(path.join(redirectedRoot, 'osg-desktop.exe')),
    /root must be one real directory/u,
  );

  const nestedRedirect = path.join(fixture.installedRoot, 'redirect');
  fs.symlinkSync(
    path.join(fixture.installedRoot, 'workers'),
    nestedRedirect,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => payloadInventory(fixture.executablePath), /redirected/u);
  fs.unlinkSync(nestedRedirect);

  const hardlink = path.join(fixture.installedRoot, 'osg-copy.exe');
  fs.linkSync(fixture.executablePath, hardlink);
  assert.throws(() => payloadInventory(fixture.executablePath), /hard-linked/u);
});

test('unsigned, altered, and foreign-key receipts fail before they become installed evidence', (context) => {
  const fixture = createFixture(context);
  const receipt = makeReceipt(fixture);
  const unsignedPath = path.join(fixture.root, 'unsigned.json');
  fs.writeFileSync(unsignedPath, packageReceiptBytes(receipt));
  assert.throws(() => verify(fixture, unsignedPath), /ENOENT|signature/u);

  const receiptPath = writeSignedReceipt({
    root: fixture.root, receipt, signer: fixture.trusted,
  });
  fs.appendFileSync(receiptPath, ' ');
  assert.throws(() => verify(fixture, receiptPath), /signature is invalid/u);

  const foreign = makeSigningKey(fixture.root);
  const foreignPath = writeSignedReceipt({ root: fixture.root, receipt, signer: foreign });
  assert.throws(() => verify(fixture, foreignPath), /foreign key/u);
});

test('signed payload paths must be unique, ordered, and traversal-free', (context) => {
  const fixture = createFixture(context);
  const base = makeReceipt(fixture);
  for (const mutate of [
    (entries) => entries.reverse(),
    (entries) => entries.splice(1, 0, { ...entries[0] }),
    (entries) => { entries[0] = { ...entries[0], path: '../escape' }; },
    (entries) => entries.push({ ...entries[0], path: entries[0].path.toUpperCase() }),
  ]) {
    const payloadEntries = structuredClone(base.payloadEntries);
    mutate(payloadEntries);
    const receipt = {
      ...base,
      payloadEntries,
      applicationHash: applicationHashForPayload(payloadEntries),
    };
    const receiptPath = writeSignedReceipt({
      root: fixture.root, receipt, signer: fixture.trusted,
    });
    assert.throws(() => verify(fixture, receiptPath), /does not match/u);
  }
});

test('a trusted signature cannot attach a receipt to a different clean source checkout', (context) => {
  const fixture = createFixture(context);
  const repositoryRoot = path.join(fixture.root, 'repository');
  fs.mkdirSync(repositoryRoot);
  const git = (...args) => spawnSync('git', args, {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(git('init').status, 0);
  assert.equal(git('config', 'user.email', 'receipt-test@example.invalid').status, 0);
  assert.equal(git('config', 'user.name', 'Receipt Test').status, 0);
  assert.equal(git('commit', '--allow-empty', '-m', 'fixture').status, 0);

  const receiptPath = writeSignedReceipt({
    root: fixture.root,
    receipt: makeReceipt(fixture),
    signer: fixture.trusted,
  });
  assert.throws(
    () => verify(fixture, receiptPath, { repositoryRoot }),
    /does not match/u,
  );
});

test('publication inventories the installed uninstaller and authenticates exact receipt bytes', (context) => {
  const fixture = createFixture(context);
  const repositoryRoot = path.join(fixture.root, 'repository');
  fs.mkdirSync(repositoryRoot);
  const git = (...args) => spawnSync('git', args, {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(git('init').status, 0);
  assert.equal(git('config', 'user.email', 'receipt-test@example.invalid').status, 0);
  assert.equal(git('config', 'user.name', 'Receipt Test').status, 0);
  assert.equal(git('commit', '--allow-empty', '-m', 'fixture').status, 0);
  const receiptPath = path.join(fixture.root, 'published.json');
  const publication = () => publishInstallerPackageReceipt({
    installerPath: fixture.installerPath,
    installedExecutablePath: fixture.executablePath,
    repositoryRoot,
    outputPath: receiptPath,
    publicKeyPath: fixture.trusted.publicKeyPath,
    signReceipt: ({ receiptPath: target }) => {
      fs.writeFileSync(`${target}.sig`, fixture.trusted.sign(fs.readFileSync(target)), { flag: 'wx' });
    },
    payloadContract: fixture.payloadContract,
  });
  const extra = path.join(fixture.installedRoot, 'payload.dll');
  fs.writeFileSync(extra, 'unreviewed-at-publication-time');
  assert.throws(publication, /authoritative package resource set/u);
  assert.equal(fs.existsSync(receiptPath), false);
  assert.equal(fs.existsSync(`${receiptPath}.sig`), false);
  fs.rmSync(extra);
  const published = publication();
  assert.ok(published.payloadEntries.some(({ path: portable }) => portable === 'uninstall.exe'));
  assert.doesNotThrow(() => verify(fixture, receiptPath, { repositoryRoot }));
});
