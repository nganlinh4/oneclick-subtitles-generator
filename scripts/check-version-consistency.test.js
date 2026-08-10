const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertAllVersionsMatch,
  assertDesktopUsesWorkspaceVersion,
  extractCargoWorkspaceVersion,
} = require('./check-version-consistency');

test('extracts the workspace package version without accepting dependency versions', () => {
  const cargo = `
[workspace]
resolver = "3"

[workspace.package]
edition = "2024"
version = "2.3.4-beta.1"

[workspace.dependencies]
serde = "1.0.0"
`;

  assert.equal(extractCargoWorkspaceVersion(cargo), '2.3.4-beta.1');
});

test('reports every version source when one source drifts', () => {
  assert.throws(
    () =>
      assertAllVersionsMatch([
        { name: 'package.json', version: '2.0.0' },
        { name: 'Cargo.toml', version: '2.0.1' },
        { name: 'tauri.conf.json', version: '2.0.0' },
      ]),
    /package\.json: 2\.0\.0[\s\S]*Cargo\.toml: 2\.0\.1[\s\S]*tauri\.conf\.json: 2\.0\.0/,
  );
});

test('requires the Tauri crate to inherit the workspace version', () => {
  assert.doesNotThrow(() =>
    assertDesktopUsesWorkspaceVersion('[package]\nname = "desktop"\nversion.workspace = true\n'),
  );
  assert.throws(
    () => assertDesktopUsesWorkspaceVersion('[package]\nname = "desktop"\nversion = "2.0.0"\n'),
    /must inherit version\.workspace/,
  );
});
