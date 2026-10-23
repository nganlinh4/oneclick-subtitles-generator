# Releasing OSG

Windows x64 is the only shipped target. A release is a GitHub release `v<version>` whose only asset
is the NSIS installer, plus a signed updater feed. Nothing here is automatic: every publish step
needs the owner's approval.

## Where things live

| What | Where |
| --- | --- |
| Installer | Release `v<version>`, asset `OSG-<version>-windows-x64-setup.exe` |
| Signature and signed package receipt | Release `osg-runtime-bundles-v1`, named `OSG-<version>-windows-x64-<installer-sha256>.exe.sig`, `...exe.osg-package-receipt.json` and `...json.sig` |
| Live updater feed | `osg-desktop-updater-v2.json` on the `app-update-feed` branch, read through `raw.githubusercontent.com` (`apps/desktop/src-tauri/tauri.conf.json`) |
| Signing key | Public key in `apps/desktop/src-tauri/updater-public-key.txt`; private key only in the `TAURI_SIGNING_PRIVATE_KEY*` Actions secrets |

`osg-runtime-bundles-v1` is append-only. Never overwrite or delete an asset there, and never replace
a published installer under the same version.

## Steps

1. **Bump the version** in `package.json`, `apps/desktop/package.json`, both lockfiles, the
   workspace `Cargo.toml` and `tauri.conf.json`, then run `npm run check:versions`. Run `npm run verify` and
   `npm run verify:native`, commit, and push `rewrite/tauri-rust`.
2. **CI must be green** on that commit (`Rewrite CI` push run). On hosted runners the GPU export
   tests print `SKIPPED`; run them on a local GPU (`npm run cargo:test`) before releasing.
3. **Build and test the candidate on a clean runner:**

   ```powershell
   gh workflow run rewrite-ci.yml --ref rewrite/tauri-rust -f job=installed-smoke
   gh workflow run rewrite-ci.yml --ref rewrite/tauri-rust -f job=signed-updater-smoke
   ```

   `installed-smoke` builds, signs, installs, launches, edits, relaunches and uninstalls the exact
   installer, then uploads `native-release-candidate-<sha>` (installer, `.sig`, signed receipt,
   draft feed). `signed-updater-smoke` proves a signed update installs and relaunches. Check both
   ran on the commit you mean, and look at the uploaded screenshots, not only the job status.
4. **Draft the release.** Download the candidate artifact, rename the installer to
   `OSG-<version>-windows-x64-setup.exe`, and create a draft `v<version>` release with that one
   asset. Upload the `.sig` and receipt files to `osg-runtime-bundles-v1` under the
   installer-hash names above. Read every uploaded file back over public HTTPS and compare bytes.
5. **Publish** (owner approval): `gh release edit v<version> --draft=false --latest`. Download the
   public installer and confirm its length and SHA-256 match the candidate.
6. **Run the published smoke:** `gh workflow run rewrite-ci.yml --ref rewrite/tauri-rust -f job=published-installed-smoke`.
   It installs the public bytes and verifies them against the `v<version>` tag.
7. **Promote the feed last.** Generate the feed from the signed installer with
   `node scripts/build-updater-manifest.js --bundle-root <dir> --base-url https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/v<version> --platform windows-x86_64-nsis --notes "OSG <version>"`,
   make sure its `url` is the public asset URL, commit it as `osg-desktop-updater-v2.json` on
   `app-update-feed` (a normal commit, never a force push), and push. Read the raw URL back and
   check the version and bytes. Never point the feed at a draft or at a lower or equal version.
8. **Update the download links** in `README.md` and `README.vi.md` on this branch and on `main`
   (`main` keeps only its READMEs in sync; its application code stays legacy).

## Things to know

- The installer is updater-signed, not Authenticode-signed, so Windows shows an unknown-publisher
  warning.
- Updates are not transactional. NSIS passive mode (`/P /R`) uninstalls, then installs; a
  half-applied update is fixed by reinstalling. There is no rollback.
- Each signed run's evidence (CI run links, hashes) belongs in the GitHub release notes, not in
  this repository.
