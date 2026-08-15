const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertRepositoryVersionContract,
  assertUpdaterVersionPair,
  collectUpdaterVersionContract,
  compareSemVer,
  deriveUpdaterSmokeVersion,
  parseWindowsSafeSemVer,
} = require('./derive-updater-smoke-version');

test('repository updater contract is consistent, increasing, and exact', () => {
  const contract = collectUpdaterVersionContract();
  assert.equal(compareSemVer(contract.updatedVersion, contract.baseVersion), 1);
  assert.deepEqual(
    assertRepositoryVersionContract(contract.baseVersion, contract.updatedVersion),
    contract,
  );
  assert.throws(
    () => assertRepositoryVersionContract(contract.baseVersion, contract.baseVersion),
    /greater/,
  );
});

test('stable updater fixtures increment with Windows-safe carry', () => {
  for (const [base, updated] of [
    ['0.0.0', '0.0.1'],
    ['1.2.3+build.9', '1.2.4'],
    ['1.2.65535', '1.3.0'],
    ['1.65535.65535', '2.0.0'],
    ['65535.65535.65534', '65535.65535.65535'],
  ]) {
    assert.equal(deriveUpdaterSmokeVersion(base), updated);
    assert.equal(compareSemVer(updated, base), 1);
  }
});

test('prerelease updater fixtures advance to the stable version at the same core', () => {
  for (const [base, updated] of [
    ['0.0.0-0', '0.0.0'],
    ['1.2.3-rc.7+build.9', '1.2.3'],
    ['65535.65535.65535-rc.1', '65535.65535.65535'],
  ]) {
    assert.equal(deriveUpdaterSmokeVersion(base), updated);
    assert.equal(compareSemVer(updated, base), 1);
  }
});

test('semantic-version precedence handles numeric, lexical, stable, and build identifiers', () => {
  assert.equal(compareSemVer('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareSemVer('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareSemVer('1.0.0', '1.0.0-rc.99'), 1);
  assert.equal(compareSemVer('1.0.0+one', '1.0.0+two'), 0);
  assert.doesNotThrow(() => assertUpdaterVersionPair('1.0.0-rc.1', '1.0.0'));
  assert.throws(() => assertUpdaterVersionPair('1.0.0', '1.0.0+new-build'), /greater/);
  assert.throws(() => assertUpdaterVersionPair('2.0.0', '1.99.99'), /greater/);
});

test('Windows NSIS component limits fail closed instead of wrapping', () => {
  assert.doesNotThrow(() => parseWindowsSafeSemVer('65535.65535.65535'));
  assert.doesNotThrow(() => parseWindowsSafeSemVer('1.2.3+65535'));
  assert.doesNotThrow(() => parseWindowsSafeSemVer('1.2.3+build.65536'));
  for (const version of ['65536.0.0', '0.65536.0', '0.0.65536']) {
    assert.throws(() => parseWindowsSafeSemVer(version), /component limit/);
  }
  assert.throws(() => parseWindowsSafeSemVer('1.2.3+65536'), /numeric build metadata/);
  assert.throws(
    () => deriveUpdaterSmokeVersion('65535.65535.65535'),
    /exhausts the Windows NSIS version space/,
  );
});

test('invalid and non-canonical semantic versions are rejected', () => {
  for (const version of [
    '', 'v1.0.0', '1.0', '1.0.0.0', '01.0.0', '1.01.0', '1.0.01',
    '1.0.0-', '1.0.0-01', '1.0.0-alpha..1', '1.0.0+', '1.0.0+build..1',
    '1.0.0_rc.1', ' 1.0.0', '1.0.0 ',
  ]) {
    assert.throws(() => parseWindowsSafeSemVer(version), /valid semantic version/);
  }
  assert.doesNotThrow(() => parseWindowsSafeSemVer('1.0.0-01a'));
});
