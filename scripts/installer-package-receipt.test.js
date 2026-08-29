const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applicationHashForPayload,
  packageReceiptBytes,
  readAndVerifyInstallerPackageReceipt,
} = require('./installer-package-receipt.js');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('a foreign same-version installer or installed executable cannot inherit current source', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-installer-receipt-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'installer.exe');
  const foreignInstaller = path.join(root, 'foreign-installer.exe');
  const payload = path.join(root, 'osg-desktop.exe');
  const foreignPayload = path.join(root, 'foreign-osg-desktop.exe');
  const receiptPath = path.join(root, 'receipt.json');
  fs.writeFileSync(installer, 'installer-for-current-source');
  fs.writeFileSync(foreignInstaller, 'same-version-foreign-installer');
  fs.writeFileSync(payload, 'packaged-current-executable');
  fs.writeFileSync(foreignPayload, 'same-version-foreign-executable');
  const payloadExecutableSha256 = digest(fs.readFileSync(payload));
  const payloadFiles = [{
    path: 'osg-desktop.exe', size: fs.statSync(payload).size, sha256: payloadExecutableSha256,
  }];
  const receipt = {
    source: { commit: '1'.repeat(40), tree: '2'.repeat(40), dirty: false },
    applicationHash: applicationHashForPayload(payloadFiles),
    payloadFiles,
    payloadExecutableSha256,
    installerSha256: digest(fs.readFileSync(installer)),
  };
  fs.writeFileSync(receiptPath, packageReceiptBytes(receipt));
  assert.doesNotThrow(() => readAndVerifyInstallerPackageReceipt({
    receiptPath,
    installerPath: installer,
    installedExecutablePath: payload,
  }));
  assert.throws(() => readAndVerifyInstallerPackageReceipt({
    receiptPath,
    installerPath: foreignInstaller,
    installedExecutablePath: payload,
  }), /does not match/u);
  assert.throws(() => readAndVerifyInstallerPackageReceipt({
    receiptPath,
    installerPath: installer,
    installedExecutablePath: foreignPayload,
  }), /does not match/u);
});
