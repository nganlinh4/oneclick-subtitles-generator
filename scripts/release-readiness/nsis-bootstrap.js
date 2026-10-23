'use strict';

// The NSIS toolchain that builds the shipped Windows installer is downloaded by
// scripts/prepare-tauri-nsis.ps1. Its two artifacts are content-addressed: exact HTTPS sources,
// sizes, and hashes, verified before use, with no other download route.

const { escapeRegularExpression, invariant } = require('./shared');

const PINNED_NSIS_ARTIFACTS = Object.freeze([
  Object.freeze({
    name: 'nsis-3.11.zip',
    url: 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip',
    size: '2361546L',
    sha256: 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1',
    sha1: 'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d',
  }),
  Object.freeze({
    name: 'nsis_tauri_utils.dll',
    url: 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll',
    size: '34304L',
    sha256: '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709',
    sha1: '75197fee3c6a814fe035788d1c34ead39349b860',
  }),
]);

/** An uncommented line holding exactly `line` (surrounding indentation allowed). */
const hasExactLine = (script, line) => new RegExp(
  `^[ \\t]*${escapeRegularExpression(line)}[ \\t]*$`,
  'm',
).test(script);

function assertTauriNsisBootstrapScript(script) {
  invariant(
    !/<#|#>/.test(script),
    'Tauri NSIS bootstrap must not contain PowerShell block comments that can hide reviewed controls',
  );
  for (const artifact of PINNED_NSIS_ARTIFACTS) {
    const artifactRecord = new RegExp(
      `^[ \\t]+Name = '${escapeRegularExpression(artifact.name)}'[ \\t]*\\r?\\n`
        + `[ \\t]+Url = '${escapeRegularExpression(artifact.url)}'[ \\t]*\\r?\\n`
        + `[ \\t]+Size = ${artifact.size}[ \\t]*\\r?\\n`
        + `[ \\t]+Sha256 = '${artifact.sha256}'[ \\t]*\\r?\\n`
        + `[ \\t]+TauriSha1 = '${artifact.sha1}'[ \\t]*$`,
      'm',
    );
    invariant(
      artifactRecord.test(script),
      `Tauri NSIS bootstrap is missing the exact ordered metadata for ${artifact.name}`,
    );
  }
  invariant(
    (script.match(/^[ \t]+Url = 'https:\/\/[^']+'[ \t]*$/gm) || []).length === PINNED_NSIS_ARTIFACTS.length,
    'Tauri NSIS bootstrap must define exactly two reviewed HTTPS artifact sources',
  );
  invariant(
    !/http:\/\//i.test(script)
      && !/(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|System\.Net\.WebClient)/i.test(script)
      && !/TAURI_BUNDLER_TOOLS_GITHUB_MIRROR/i.test(script),
    'Tauri NSIS bootstrap must use only its exact reviewed HTTPS sources',
  );
  for (const fragment of ["--proto '=https' `", "--proto-redir '=https' `"]) {
    invariant(hasExactLine(script, fragment),
      `Tauri NSIS bootstrap must restrict downloads and redirects to HTTPS: ${fragment}`);
  }
  for (const fragment of [
    'if ((Get-Item -LiteralPath $Path).Length -ne $Artifact.Size) {',
    '$sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()',
    'if ($sha256 -cne $Artifact.Sha256) {',
    'Assert-PinnedFile -Path $Destination -Artifact $Artifact',
  ]) {
    invariant(hasExactLine(script, fragment),
      `Tauri NSIS bootstrap must verify size and SHA-256 of every download: ${fragment}`);
  }
}

module.exports = { assertTauriNsisBootstrapScript };
