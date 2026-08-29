#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readCleanGitSourceProvenance } = require('./git-source-provenance.js');

const HASH = /^[0-9a-f]{64}$/u;
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const payloadInventory = (executablePath) => {
  const root = path.dirname(executablePath);
  const files = [];
  const add = (absolute, portable) => {
    const status = fs.lstatSync(absolute);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('package payload is redirected');
    files.push({ path: portable, size: status.size, sha256: sha256(absolute) });
  };
  add(executablePath, 'osg-desktop.exe');
  const visit = (directory, prefix) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const portable = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(absolute, portable);
      else add(absolute, portable);
    }
  };
  for (const directory of ['licenses', 'ui-fonts', 'workers']) {
    visit(path.join(root, directory), directory);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
};
const applicationHashForPayload = (payloadFiles) => crypto.createHash('sha256')
  .update(`${JSON.stringify({ payloadFiles })}\n`)
  .digest('hex');

const packageReceiptBytes = ({
  source, applicationHash, payloadFiles, payloadExecutableSha256, installerSha256,
}) => (
  Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    publisher: 'osg-installer-package-receipt',
    source,
    applicationHash,
    payloadFiles,
    payloadExecutableSha256,
    installerSha256,
  }, null, 2)}\n`)
);

const publishInstallerPackageReceipt = ({ installerPath, payloadExecutablePath, repositoryRoot, outputPath }) => {
  const installerSha256 = sha256(installerPath);
  const payloadFiles = payloadInventory(payloadExecutablePath);
  const payloadExecutableSha256 = payloadFiles.find(({ path: portable }) => (
    portable === 'osg-desktop.exe'
  )).sha256;
  const receipt = {
    source: readCleanGitSourceProvenance({ repositoryRoot }),
    applicationHash: applicationHashForPayload(payloadFiles),
    payloadFiles,
    payloadExecutableSha256,
    installerSha256,
  };
  fs.writeFileSync(outputPath, packageReceiptBytes(receipt), { flag: 'wx', mode: 0o600 });
  return Object.freeze({ ...receipt, receiptPath: path.resolve(outputPath) });
};

const readAndVerifyInstallerPackageReceipt = ({ receiptPath, installerPath, installedExecutablePath }) => {
  const bytes = fs.readFileSync(receiptPath);
  const value = JSON.parse(bytes);
  if (
    value?.schemaVersion !== 1
    || value.publisher !== 'osg-installer-package-receipt'
    || Object.keys(value).sort().join('|')
      !== 'applicationHash|installerSha256|payloadExecutableSha256|payloadFiles|publisher|schemaVersion|source'
    || value.source?.dirty !== false
    || !/^[0-9a-f]{40,64}$/u.test(value.source?.commit ?? '')
    || !/^[0-9a-f]{40,64}$/u.test(value.source?.tree ?? '')
    || !HASH.test(value.applicationHash ?? '')
    || !HASH.test(value.payloadExecutableSha256 ?? '')
    || !HASH.test(value.installerSha256 ?? '')
    || !Array.isArray(value.payloadFiles)
    || value.payloadFiles.length === 0
    || !value.payloadFiles.some((file) => file?.path === 'osg-desktop.exe')
    || value.payloadFiles.some((file) => (
      typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || !HASH.test(file.sha256 ?? '')
    ))
    || value.applicationHash !== applicationHashForPayload(value.payloadFiles)
    || value.payloadExecutableSha256
      !== value.payloadFiles.find((file) => file.path === 'osg-desktop.exe').sha256
    || value.installerSha256 !== sha256(installerPath)
    || (installedExecutablePath !== undefined
      && JSON.stringify(value.payloadFiles) !== JSON.stringify(payloadInventory(installedExecutablePath)))
  ) throw new Error('installer package receipt does not match its source/package/installed payload');
  return Object.freeze({
    ...value,
    receiptSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
};

if (require.main === module) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  if (args.has('--payload-exe')) {
    const published = publishInstallerPackageReceipt({
      receiptPath: args.get('--receipt'),
      outputPath: args.get('--receipt'),
      installerPath: args.get('--installer'),
      payloadExecutablePath: args.get('--payload-exe'),
      repositoryRoot: args.get('--repository-root'),
    });
    process.stdout.write(`${JSON.stringify(published)}\n`);
  } else {
    const verified = readAndVerifyInstallerPackageReceipt({
      receiptPath: args.get('--receipt'),
      installerPath: args.get('--installer'),
      installedExecutablePath: args.get('--installed-exe'),
    });
    process.stdout.write(`${JSON.stringify(verified)}\n`);
  }
}

module.exports = {
  applicationHashForPayload,
  packageReceiptBytes,
  publishInstallerPackageReceipt,
  readAndVerifyInstallerPackageReceipt,
};
