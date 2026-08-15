# Codex → Claude handoff — ACTIVE COMPLETION ORDER + WORK RECORD

Original handoff generated: 2026-08-15 (Asia/Seoul), by Codex.
First-pass work completed by Claude: 2026-08-15. **That pass was not committed, pushed, or
published.**
Repository: `C:\WORK\oneclick-subtitles-generator`, branch `rewrite/tauri-rust`.

This file was the Codex→Claude handoff. It now has two purposes:

1. preserve the verified work record below, and
2. act as the **authoritative work order for completing every remaining release task**.

The receiving Claude session must not treat the existing green tests or the historical wording
"owner-gated" as permission to stop. Use Claude's subagents/swarms aggressively for independent
implementation, adversarial review, cross-platform review, and gate execution. Keep the main agent
as integrator and require fresh reviewers on each frozen slice.

---

## 0. Mandatory continuation directive (read this first)

The user explicitly wants the remaining work **checked, implemented, reviewed, and driven as far as
the available environment and credentials permit**. This is not a request for another status-only
pass. Make substantial changes where the root design requires them. Do not keep asking the user to
choose ordinary engineering details: investigate competing designs, select the safest durable
design, implement it, and prove it with hostile tests.

### Authority and safety boundaries

- You are authorized to refactor across packages, add migrations/APIs/tests, split oversized
  modules, repair build tooling, and create local checkpoint/final commits after gates pass.
- Preserve the safety checkpoint commit `650805d36837d36f3b4aad025d0e54bac3708d41`
  (`wip: checkpoint parity rewrite before Claude handoff`). Never rewrite or discard it.
- Preserve unrelated user changes. Do not use destructive reset/checkout operations.
- Do **not** raise or disable the frontend bundle budget, weaken tests/contracts, suppress warnings,
  forge readiness hashes, bypass managed-delivery checks, or mark work complete based on mocked-only
  evidence.
- Do not push branches, publish a GitHub release asset, rotate/generate production signing secrets,
  or make another irreversible external publication without explicit user authorization at that
  exact step. Prepare everything before that boundary so the final request is one precise action,
  not a vague design question.
- Existing configured task credentials may be used for read-only inspection and reversible local
  verification. Never expose credentials or native filesystem paths in IPC/UI payloads/logs.
- If an external credential or legal owner decision is the sole remaining barrier, record the exact
  command/artifact/hash/choice required and continue all independent work instead of stopping the
  whole effort.

### Current repository state

- Repository: `C:\WORK\oneclick-subtitles-generator`
- Branch: `rewrite/tauri-rust`
- Safety checkpoint: `650805d3`
- Claude's post-checkpoint implementation is currently **uncommitted**: 18 tracked files modified
  and 2 new activation files. The exact list and hashes are recorded below.
- The handoff itself is intentionally modified. Do not delete it until its checklist has been
  transferred into the final completion report.
- Independently re-run after Claude's first pass: full Vitest **210 files / 1,576 tests**, ESLint,
  native lint, i18n, Tauri contract, production-transport, readiness tests, compile-readiness, and
  `git diff --check` all passed. These are evidence, not a waiver from rerunning after new work.

### Definition of “complete”

Completion requires all of the following, not merely an explanation:

1. Every task in the mandatory queue below is either implemented and independently approved, or is
   reduced to one genuinely unavailable external secret/publication/legal choice with every local
   prerequisite finished.
2. No known reachable correctness, ownership, persistence, security, ABI, or cross-project race is
   left behind as “out of scope.”
3. The normal production build passes its existing budgets and contracts without disabling plugins
   or increasing limits.
4. Desktop Rust compiles/tests/clippy under the real managed-delivery contract after the legitimate
   delivery artifact is available.
5. Packaging/install/launch and the installed-application smoke path are exercised, not just unit
   mocks, wherever the local machine and signing/publication boundary allow.
6. Full JS, Rust, lint, formatting, i18n, transport, Tauri command/ACL, readiness, managed-delivery,
   visual/provenance, package, and repository diff gates are rerun on final frozen bytes.
7. At least one fresh read-only adversarial reviewer checks each high-risk final slice, plus one
   integrated final reviewer checks cross-slice behavior.
8. Final local commits are small enough to audit and have accurate messages. Do not push them.

### Mandatory remaining-work queue

#### A. Durable relaunch media restoration — design and implement, do not leave inert

The current mount hydration is knowingly inert. Fix the root identity contract rather than adding a
JS-only activation call:

- Introduce a durable, path-private association from a media asset to its owning subtitle project
  or durable project alias. It must distinguish `assetId`, stable content/cache identity, URL alias,
  and project ID; do not reuse one identifier for another role.
- Preserve URL-keyed subtitles, rules, auxiliary state, revisions, and history. Relaunch must never
  mint an empty asset-ID-keyed project when a URL alias already owns the media.
- Define the local-picker lifecycle: candidate/import, project claim/promotion, activation, restart,
  replacement, discard, and cleanup. If a native reopen primitive is required, expose the narrowest
  project-authorized command; do not expose raw paths or a general unowned-open escape hatch.
- Make activation latest-intent/project/revision owned and safe against A→B switches during every
  awaited lookup/open. A stale restore cannot publish or deactivate another project.
- Hydration must fail closed on malformed/missing/stale associations without corrupting storage,
  and retry after transient availability when appropriate.
- Add real persistence/reopen tests for local files and URL downloads, alias remap/deletion,
  same-content/different-project cases, stale concurrent hydration, project history/undo, missing
  artifacts, and exact cleanup. Include native Rust/storage plus production JS integration.
- Replace the partial best-effort `useVideoUpload` rollback with the durable contract where that is
  the correct caller; preserve actionable user errors if cleanup fails.

#### B. Frontend entry budget — make the normal build pass without moving the goalposts

Current entry is approximately `1,634,156` bytes against the fixed `1,550,000` limit. Find the real
module contributors using the production graph/metafile. Create effective, intentional split points
or remove duplication/dead reachability. Preserve async-boundary enforcement: required-effective
targets may never be placed in the intentional-warning suppression map. Verify:

- normal `npm run build:vite` passes with the existing budget plugin enabled;
- no new ineffective dynamic-import warning is suppressed merely to pass;
- desktop production output excludes browser-only providers, raw image/media bytes, secrets,
  development helpers, and unreachable compatibility transports;
- route/startup behavior, CSP, Remotion, and production-transport tests remain green.

#### C. Managed-delivery Remotion artifact — finish all local work, then cross the external boundary explicitly

Rebuild the deterministic Windows Remotion runtime/archive from the six drifted sources listed
below. Verify archive contents, size, SHA-256, reproducibility, and actual worker execution before
publication. Prepare the exact content-addressed filename, manifest patch, upload command, and
read-back verification. If explicit publication authorization and credentials are available, carry
out the documented append-only upload and update the checkpoint legitimately. Otherwise stop only
at the upload call, report the exact artifact/hash/command, and continue D–I. Never use `--write`
against an unpublished/unread-back artifact.

After publication, run `verify:managed-delivery`, desktop Cargo gates, the production build, package,
install, launch, and installed smoke workflows. Confirm the packaged app consumes the exact
published archive rather than a workspace fallback.

#### D. Updater signing — complete the implementation around the secret boundary

Audit updater configuration and the full create/sign/verify/install/rollback path. Finish all code,
CI, documentation, key-location validation, public-key wiring, malformed/tampered artifact tests,
and safe disabled-state behavior. Never generate or commit a production private key. If the only
missing item is the owner's real public/private key material, state exactly where the public key is
inserted and which secret name supplies the private key, with a disposable test-key proof kept out
of version control.

#### E. Licence and notices — produce a defensible release policy and artifacts

Inventory Rust, npm, bundled binaries/models, FFmpeg/ffprobe, Remotion, fonts, model weights, and
downloaded runtime payloads. Select and document a conservative redistribution policy compatible
with the actual package composition, generate/update notices and source-offer instructions where
required, and make release-readiness enforce it. Separate legal uncertainty from engineering facts;
do not silently call GPL payloads redistributable. If a final owner/legal choice remains, present a
small explicit choice table after generating every neutral inventory/report that does not require
that choice.

#### F. Oversized native URL adapter — finish the deferred structural cleanup

`nativeUrlDownloadAdapter.js` is 890 lines against the 600-line guideline. Split along the already
identified seam (request normalization/failure/listener helpers versus operation state machine) or
a better cohesion boundary. Preserve subscriber-local ownership, exact-once cancellation/discard,
cached replay semantics, normalized URL/browser/language operation keys, hostile Signal handling,
and manual/auto coalescing. Require mutation/hostile regression tests and a fresh concurrency review.
Do not split merely by moving a giant closure unchanged into another oversized file.

#### G. Rust flake and cross-platform behavior — reproduce or harden

Investigate `osg-media-server::tests::oversized_headers_are_rejected_without_growing_unbounded`
under parallel/full-workspace load. Decide from evidence whether the failure is a product race,
test-port/resource collision, scheduling assumption, or genuinely harmless flake. Fix the root test
or implementation and run repeated/parallel stress on Windows plus applicable Unix CI semantics.
Do not hide it with retries or `#[ignore]`.

#### H. Full integrated adversarial review

Use independent swarm agents, each read-only against frozen hashes, for at least:

- media/project identity, relaunch, activation, history, discard, and cross-project races;
- URL/manual/auto download coalescing, cached replay, cancellation, hostile JS accessors/signals;
- storage migrations/reopen/reconciliation and multi-process behavior;
- speech/render/generated-image capability lifecycle and Stop/abort races;
- translation/document export ownership and dynamic-boundary reachability;
- Tauri command registration/ACL/DTO/path/secret containment;
- release packaging, managed payload provenance, updater, licences, and installed behavior;
- performance/bundle graph and cross-platform release matrix.

A reviewer rejection must be root-fixed and freshly reviewed; do not let the implementing agent
self-approve. Preserve exact hashes for every frozen review.

#### I. Final gates, commits, and handoff closure

Run the repository's documented complete release matrix on final bytes. At minimum include full
Vitest, all relevant Rust workspace/desktop tests, strict clippy all-targets, rustfmt, ESLint/native
lint, TypeScript, i18n, visual/provenance, Tauri contract/ACL, production transport, readiness
profiles, managed delivery, ordinary Vite production build, package/install/launch/smoke, diff-check,
and clean `git status`. Record exact commands and counts.

Create logical local commits after the corresponding gates and independent reviews pass. Do not
push. Update this file into a final completion record containing:

- commit IDs;
- exact remaining external-only blockers, if any;
- final frozen hashes for high-risk files;
- test/gate results;
- package/install/smoke evidence;
- no euphemistic “owner-gated” bucket containing executable engineering work.

If context becomes tight, write/update this file **before** compaction and have a subagent verify the
record against `git diff`, gate output, and frozen hashes.

### Recommended swarm execution and integration discipline

Use parallelism, but assign explicit file ownership and keep shared integration serialized:

1. **Wave 1 — independent discovery:** one agent designs/reproduces A, one profiles B, one prepares
   C/D/E inventories and artifacts without publishing, and one reproduces G. These agents begin
   read-only and report concrete counterexamples/designs before edits.
2. **Wave 2 — scoped implementation:** dedicate writers to A, B, F, and G. Do not let two writers
   concurrently edit `lib.rs`, `build.rs`, permissions, migrations, Cargo manifests/lock,
   readiness scripts, delivery manifests, or this handoff. Queue those shared edits through the
   main integrator after each writer freezes exact hashes.
3. **Wave 3 — fresh adversarial review:** reviewers must receive frozen hashes and the hostile
   checklist, have read-only instructions, and report APPROVE/REJECT with executable evidence.
   A writer may not review its own final bytes.
4. **Wave 4 — release integration:** main agent applies command/ACL/manifest/checkpoint integration,
   reruns cross-slice tests, then performs C/D/E external-boundary work as authorized.
5. **Wave 5 — clean-room final:** a fresh agent starts from the final local commits, checks the
   worktree and all frozen hashes, runs the integrated release matrix, and audits the final report
   for unsupported “green” claims.

Agents must send concise checkpoints before touching shared files and freeze immediately after their
scoped gates. The main agent should interrupt or redirect agents that broaden into unrelated cleanup.
Do not count a passing focused test as integrated proof when the real desktop command, package,
restart, or installed executable path has not run.

---

## Historical first-pass summary (not the current completion state)

Both executable blockers from the original handoff are fixed, release readiness is pinned honestly,
and every gate runnable during that pass was green. The red gates discovered then were described as
owner-gated (managed-delivery republish, entry bundle budget, updater signing key, licence policy).
Under the mandatory directive above, their executable portions are now required work rather than a
reason to stop.

The original handoff's constraints were respected:

- No commit / push / PR / publish.
- The frontend bundle budget was **not** raised.
- The managed-delivery checkpoint was **not** bypassed and `--write` was **not** used.
- `src/platform/projectService.js` was **not** modified — verified below by hash.
- Unrelated dirty work in the shared tree was not touched.

---

## 1. Clean-session media activation — FIXED

### Root cause (confirmed exactly as described in the original handoff)

`projectService` keeps every storage operation detached, so nothing published an active project.
`mediaService` requires an exact active project before a candidate claim and before
`open_media_asset`. A repository-wide search confirmed **zero production callers** of
`activateProject` / `activateProjectSnapshot`, so on a clean session every URL and quality download
failed with `invalidMediaRequest` before native IPC.

### What was implemented

New module `src/platform/mediaProjectActivation.js` — the only place a media operation may publish
an active project. It deliberately does **not** live in `mediaService`, because activating inside
the claim would make the claim's own pre-check self-fulfilling.

`activateResolvedMediaProject(resolved, { validateOwnership })`:

1. Hostile-normalizes the `{ cacheId, projectId, snapshot }` resolution by property descriptor
   (no accessor is invoked), exposing only the exact claim identity.
2. Revalidates ownership **before** publication.
3. Refuses to republish an **older** revision of a project that is already active — this stops a
   stale resolution from regressing subscribers and from letting a stale claim commit over newer
   durable work.
4. Claims a monotonic activation intent and publishes in the same synchronous step, so no other
   activation can interleave between the claim and the publication it authorises.
5. Verifies the exact `projectId` + `stateVersion` actually landed — a subscriber may synchronously
   activate another project during publication (`projectService` documents this).
6. Revalidates ownership **after** publication, and re-checks intent + publication.
7. Returns `Object.freeze({ claimOptions, release })`.

`release()` is doubly guarded and only withdraws an untouched publication:

- no-op if a **newer intent** owns the publication channel, and
- no-op if a **later revision** of the same project is published — i.e. a concurrent operation
  committed on top and now owns it.

`claimOptions` is a frozen exact-keys record matching `normalizeCandidateClaimOptions`' ABI, which
removes the duplicated option construction at both claim sites.

### Call sites wired

| Path | Change |
| --- | --- |
| `src/platform/nativeUrlDownloadAdapter.js` — `onCompleted` | resolve → publish (ownership revalidated around it) → claim → `release()` on claim failure |
| `src/platform/nativeUrlDownloadAdapter.js` — cached completed-asset reopen | resolve → publish → `openAsset`; publication failure does **not** evict the cached capability |
| `src/components/qualityModal/useQualityProgressTracking.js` | resolve → cancel check → publish → cancel check → claim → `release()` on failure |

`subtitleProjectStore.resolveProjectForCache` and generic project reads were **not** given implicit
activation, as required.

### Collateral cleanups in the adapter (same file, while it was open)

- Deleted the private `normalizeCandidateProject` (48 lines) — superseded by, and strictly weaker
  than, `normalizeResolvedMediaProject`.
- Extracted the ~90-line inline cached-reopen branch into `reopenCompletedAsset()`; its two-stage
  semantics are preserved exactly (open failure evicts the capability; a replay-callback failure
  propagates and must **not** evict).
- Deduplicated the AbortSignal binding into `attachAbortBinding()`, now shared by `subscribe()` and
  the reopen path (removed a duplicated if/else rollback).
- Fixed a pre-existing candidate leak: when the subtitle publish failed, `onCompleted` returned
  without discarding the downloaded candidate. The whole body is now inside one `try`, so every
  early return discards exactly once.

### Tests

- New `src/platform/mediaProjectActivation.test.js` — 28 tests: hostile-resolution table
  (15 shapes), clean-session publication, before/after ownership revalidation ordering, no
  publication when ownership is already lost, release-on-post-publication-loss, older-revision
  refusal, subscriber hijack, stale-release-cannot-clobber, revision-guarded release, non-callable
  validator.
- **The reported repro is now a regression test.** Three integration tests wire the *real*
  `projectService` + `mediaProjectActivation` + `createMediaCandidateLifecycle` with only the native
  host faked: a clean session (`getActiveProjectSnapshot() === null`) claims a downloaded candidate
  end to end and ends at `stateVersion 5` with `media: [assetId]`; B winning during the commit
  rejects with `invalidMediaRequest` and B stays active; the loser's `release()` returns `false`.
- 6 new adapter tests: publish-before-claim, release-on-claim-failure, discard-exactly-once on
  ownership loss inside the publication, publish-before-cached-reopen, release on genuine reopen
  failure, and cached capability preserved when publication fails.
- 2 new `useVideoUpload` tests (see §5).

---

## 2. Translation effective async boundary — FIXED

`src/hooks/useTranslationState.js:16`'s static `lifecycleOrchestrator` import is gone. It now uses
the established literal dynamic-import pattern (the same shape as
`src/hooks/useSubtitlesSegmentRetry.js:38`):

```js
const loadLifecycleOrchestrator = () => import('../services/lifecycleOrchestrator');
```

destructured at both `TRANSLATION_START` checkpoint sites. The ownership sandwich is preserved and
tightened — `await assertRunOwned(context)` still runs **immediately before** each checkpoint, with
an extra assertion added after the loader await:

```js
await assertRunOwned(context);
const { checkpointBeforeUpdate } = await loadLifecycleOrchestrator();
await assertRunOwned(context);
await checkpointBeforeUpdate({ ... });
await assertRunOwned(context);
```

`scripts/frontend-bundle-boundary.mjs` inventory updated with
`'src/hooks/useTranslationState.js': 1` (the count is literal `import(...)` expressions in the file,
not checkpoint call sites — the module-level loader is one). `lifecycleOrchestrator` was **not**
added to any warning-suppression map.

### Verification of the emitted chunk

There is no budget-disabled build mode in the repo, so an ad-hoc in-memory harness was used
(scratchpad only, not added to the repository): the real production Vite config with only the
size-budget plugin filtered out, `build.write = false`. Result:

```json
{
  "entryFileName": "assets/index-DMLAOOk8.js",
  "entryBytes": 1634156,
  "lifecycleChunks": [
    { "fileName": "assets/lifecycleOrchestrator-D7FyyGpz.js", "isEntry": false, "bytes": 2104 }
  ],
  "entryHasLifecycleModule": false,
  "lifecycleLogs": [ 6 warnings, all for OTHER targets ]
}
```

Exactly one non-entry `lifecycleOrchestrator-*.js` chunk; no lifecycle module in the entry; zero
lifecycle warnings. The six remaining `INEFFECTIVE_DYNAMIC_IMPORT` warnings are the already-reviewed
suppressed set (`qualityScanner`, `alignedNarrationService`, `cacheUtils`, `videoProcessing`,
`GeminiAdapter`, `subtitleMerger`) — the build reached `generateBundle`, which proves every one of
them is suppressed by policy rather than merely tolerated.

---

## 3. Readiness pins and structural assertion — DONE, and two more stale pins found

### The pins the original handoff named

`scripts/check-release-readiness.js`:

- `DOWNLOAD_HANDLERS_SHA256` → `d3b5e42b123a386ad44c2454fba0df76f1a86009ab2e70ee3c5d9c9ec20d40a2`
  (`downloadHandlers.js` was not modified in this session — this is the value the original handoff
  predicted).
- `NATIVE_URL_DOWNLOAD_ADAPTER_SHA256` → `93cc7498c97d38bcaa2bbea91c5fdfadf67cd1f6f89e1403b7e39e54643523a4`.

Both recomputed exactly as readiness does: UTF-8, BOM stripped, `\r\n` → `\n`, SHA-256, terminal
newline preserved.

The structural fragment was updated to the final implementation **and strengthened**:

```js
&& nativeUrlDownloadAdapterSource.includes('const normalizedUrl = normalizeUrl(url);')
&& nativeUrlDownloadAdapterSource.includes(
     'const key = operationKey(normalizedUrl, cookieSource, preferredLanguages);')
```

Three new hostile mutations in `scripts/check-release-readiness.test.js` (key reverted to the raw
request URL; browser source dropped from the key; URL normalization weakened to a pass-through).

### Two further stale pins found and repaired

Running the readiness gate surfaced two assertions that were stale against code the original
handoff had already marked **approved and frozen**. Neither was caused by this session's work; both
now match the reviewed implementation and are stronger than before.

**(a) `select_media` picker pin — this was blocking the Windows release target.**
`checkRuntimePackageReadiness(root, 'x86_64-pc-windows-msvc')` failed with
`Runtime package has 1 blocking violation(s): Desktop select_media must run its parented picker on
the blocking pool and record path-free lifecycle outcomes`. The picker had been refactored out of
`select_media` into a shared `pick_media_path(window)` helper (also used by the unregistered
`select_media_candidate`), while the assertion still sliced `select_media`'s body. The invariant
itself was never violated. The assertion now targets `pick_media_path`, and additionally requires:

- `select_media` to keep delegating via `pick_media_path(window).await?`, and
- exactly **one** `rfd::FileDialog::new()` in `commands.rs` (no bypass picker), and
- `blocking_pick_file()` absent from the whole file rather than just from `select_media`.

Two new hostile fixtures cover the delegation removal and a second dialog; the fixture generator was
updated to mirror the real two-function structure.

**(b) Diagnostics application-identity pin.** `apps/desktop/src-tauri/src/diagnostics.rs` matches
the approved hash `b4048339…` byte for byte, but the assertion expected
`static APP_INSTANCE_ID: OnceLock<String>`. The approved implementation is stronger: the identity is
minted once per initialization inside `OnceLock<InitializedDiagnostics>` and threaded through the
single record encoder. The assertion now pins that shape, including that `fn encode_record(` occurs
exactly once — so no diagnostic line can be written without the identity.

### Readiness result

```
node --test scripts/check-release-readiness.test.js      → 36 tests, 36 pass, 0 fail
node scripts/check-release-readiness.js                  → Compile readiness passed
node scripts/check-release-readiness.js \
  --profile runtime-package --target x86_64-pc-windows-msvc → PASSED (3 validated resources)
```

`--profile host-toolchain` fails locally only because this machine has Node 24.12.0 against the
pinned 24.19.0. That is an environment mismatch, not a code issue.

Non-Windows targets still report exactly the three honest delivery blockers (FFmpeg/ffprobe GPL
redistribution, Remotion linux catalog, managed engine catalogs), which is what the test asserts.

Command boundary unchanged and still correct: only `discard_media_candidate` is registered;
`select_media_candidate` remains unregistered.

---

## 4. Independent approvals — DONE (0 findings survived)

A five-lens read-only adversarial review was run over the final bytes: concurrency/ordering,
adapter behaviour preservation, hostile input/DTO strictness, the two React call sites, and the
translation boundary. Every finding was then handed to an independent refuter instructed to default
to "refuted" unless the defect was real *and* newly introduced.

**7 findings raised, 7 refuted, 0 confirmed.**

Two of them were real and were fixed while the review was still running, which is why they refute
against the current bytes:

1. **`release()` had no published-revision guard.** Two operations resolving the same project could
   both publish at the same version; if one then committed successfully and the other failed its
   pre-check, the loser's `release()` would deactivate the winner's project. Fixed by the
   revision guard described in §1; covered by
   `never withdraws a publication a concurrent operation already committed on top of`.
2. **Cached-asset eviction was too broad.** A transient project-resolve/publication failure would
   evict an already-downloaded capability and force a full re-download. The reopen path now splits
   publication from open: a publication failure re-asserts listener liveness and throws
   `mediaCandidateProjectFailed` with the cache intact; only a genuine `openAsset` failure evicts.

One finding was raised as a **blocker** and refuted independently at the Rust layer before the
refuter reported: *"the adapter discards an asset the project durably references"*. It cannot
happen — `discard_candidate_in_transaction`
(`crates/osg-infrastructure/src/storage/media.rs:754`) returns `Ok(None)` unless the asset's
metadata lifecycle is still `candidate`, and its `DELETE` additionally requires
`NOT EXISTS(SELECT 1 FROM project_media WHERE media_id = ?1)`. A project commit promotes the asset
to lifecycle `'project'`, so a post-commit discard deletes nothing and returns `false`.

`projectService.js` did not change, so its reentrancy/activation-generation review did not need to
be repeated. Verified by hash below.

---

## 5. Findings outside the original handoff's scope

### (a) `useVideoUpload` rollback — FIXED (partially; the rest needs a native primitive)

`selectNativeRenderVideo` / `claimNativeRenderVideo` roll back a non-video selection with
`await restore(previous.assetId)`. That call was unguarded, so its rejection replaced the actionable
message: the user saw *"The native media request is invalid"* instead of *"Select a video file for
rendering."* This path is live (`VideoRenderingSection` → `handleBrowseClick`, and the native drop
handler).

Rollback is now best-effort via `rollbackNativeSelection`, so the caller's guidance always wins.
Two tests added.

**Not fixed, and not fixable in JS:** the restore itself cannot succeed for a locally picked asset.
`open_media_asset` requires a `project_media` row for the exact project at the exact
`state_version` with lifecycle `'project'`, and `select_media` / `media_drop_claim` store assets
with lifecycle `{}` and no `project_media` row. Only a media-candidate claim promotes an asset.
Making rollback actually restore needs a native "reopen unowned asset" command
(`reopen_media_asset_unowned` exists internally but is not exposed).

### (b) Relaunch media restore is inert — NOT FIXED, deliberately

`useNativeMediaSessionHydration` calls `restoreMediaAsset(storedAssetId)` on mount when the native
session is empty — i.e. on every relaunch. It can never succeed, for two independent reasons:

1. The Rust ownership requirement above (locally imported assets are never in any project).
2. For URL downloads, `localStorage['current_file_cache_id']` holds the **assetId**, while the
   subtitle-project alias is the **URL-based cacheId**. `resolveProjectForCache(assetId)` would not
   find the real project, and with `{ create: true }` would mint an empty one and orphan the
   URL-keyed subtitles, rules and history.

It currently fails closed (`hydrate()` returns `false`), so it is inert rather than harmful. A naive
"add activation here too" fix would introduce alias corruption. **This needs an owner decision on a
durable asset→project pointer.** No installed-EXE inspector covers relaunch media restore, so no
test would catch a regression here.

### (c) i18n release gate was red — FIXED

`npm run check:i18n` reported 4 gaps (vi and ko each missing `download.exportFailed` and
`translation.partialResult`), both from the translation/document-export work in this tree.

`download.exportFailed` was double-booked: `DownloadOptionsModal.js:130` used it for *"The document
could not be saved."* and `translation/index.js:223` for *"The subtitle archive could not be
saved."* A single localized string would have been wrong for one of them, and adding the key to
`en` would have silently overridden one call site's inline default. The key was therefore split
into `download.exportFailed` and `download.archiveExportFailed`, with en/vi/ko entries for both and
`translation/index.js` pointed at the new key. `translation.partialResult` added for en/vi/ko using
the existing plain-`{{count}}` convention (this repo uses no `_one`/`_other` plural keys).

Gate is now clean: `vi missing: 0, ko missing: 0, hardcoded user strings: 0`.

### (d) Flaky Rust test — reported, not touched

`osg-media-server` → `tests::oversized_headers_are_rejected_without_growing_unbounded` failed once
under full-workspace parallel load (expected `HTTP/1.1 431`) and passes in isolation and on a clean
re-run of the whole workspace. Pre-existing, in a crate this session did not touch.

---

## Verified gate status

| Gate | Command | Result |
| --- | --- | --- |
| Frontend tests | `npx vitest run` | **210 files / 1576 tests pass** (was 209 / 1539) |
| ESLint | `npm run lint` | pass |
| Native ESLint | `npm run lint:native` | pass |
| Tauri contract | `npm run check:tauri-contract` | pass — 124 commands, 27 custom permissions, **535** reachable modules (534 + `mediaProjectActivation.js`) |
| Transport + bundle boundary | `npm run test:production-transport` | 24 / 24 pass |
| Readiness tests | `node --test scripts/check-release-readiness.test.js` | 36 / 36 pass |
| Readiness (compile) | `node scripts/check-release-readiness.js` | **pass** (was REJECT) |
| Readiness (Windows runtime-package) | `--profile runtime-package --target x86_64-pc-windows-msvc` | **pass** |
| i18n | `npm run check:i18n` | **clean** (was 4 gaps) |
| Version consistency | `npm run check:versions` | pass — 1.0.0 |
| Rust (non-desktop) | `cargo test --workspace --exclude osg-desktop` | 529 pass, 0 fail |

---

## Historical first-pass blockers — mapped to mandatory queue A–I above

### 1. Managed-delivery checkpoint (blocks all desktop Cargo work)

`npm run check:managed-delivery` →
`managed-delivery checkpoint is stale; package authors must publish and read back new
content-addressed assets before running with --write`

Diffing the tracked checkpoint against a freshly computed one shows **only the `remotion` group**
drifted (13 → 16 bound sources):

```
ADDED   video-renderer/src/subtitleAnimationEasing.ts          2081
ADDED   video-renderer/src/subtitleCustomizationDefaults.ts    1404
ADDED   video-renderer/src/subtitleVisualMath.ts                202
CHANGED video-renderer/src/components/SubtitleCustomization.tsx 1509 -> 105
CHANGED video-renderer/src/components/SubtitledVideo.tsx       32874 -> 32734
CHANGED video-renderer/src/types.ts                             4463 -> 4531
```

`video-renderer/worker/osg_render_worker.mjs` is **unchanged** (`3e2c86b0…`, still matching the
delivery manifest), so this is purely the Remotion composition sources being refactored while the
published 265 MB Windows archive still corresponds to the old ones.

Resolving it is the documented procedure in `docs/rewrite/DOWNLOADABLE_PAYLOADS.md:93-105`:
build the Windows Remotion archive deterministically, give it a new content-addressed name, upload
it to the **append-only** `nganlinh4/oneclick-subtitles-generator @ osg-runtime-bundles-v1` pool,
read it back and verify size + SHA-256, update `video-renderer/delivery/remotion-runtime.delivery.json`,
then `python -I -B scripts/check-managed-delivery-contract.py --write` and
`npm run verify:managed-delivery`.

**Not done: step 3 is an irreversible publish to the owner's GitHub release using the owner's
credentials.** This needs explicit authorization. Until it is done,
`apps/desktop/src-tauri/build.rs` keeps stopping the desktop build, so the production build,
package/install and the real Windows EXE smoke workflows were not attempted.

### 2. Frontend entry bundle budget — still deliberately deferred

`1,634,156 > 1,550,000`. Not raised. (It was 1,634,462 before the lifecycleOrchestrator split.)

### 3. Updater signing key — unchanged

Still disabled pending the production signing public key and secured private key.

### 4. Root licence / notice policy — unchanged

Still the owner's selection to make.

---

## Files changed in this session

New:

```
src/platform/mediaProjectActivation.js
src/platform/mediaProjectActivation.test.js
```

Modified:

```
scripts/check-release-readiness.js
scripts/check-release-readiness.test.js
scripts/frontend-bundle-boundary.mjs
src/components/VideoRenderingSection/useVideoUpload.js
src/components/VideoRenderingSection/useVideoUpload.native.test.js
src/components/qualityModal/useQualityProgressTracking.js
src/components/qualityModal/useQualityProgressTracking.native.test.js
src/components/translation/index.js          (one line: exportFailed → archiveExportFailed)
src/hooks/useTranslationState.js
src/i18n/locales/{en,vi,ko}/download.json
src/i18n/locales/{en,vi,ko}/translation.json
src/platform/nativeUrlDownloadAdapter.js
src/platform/nativeUrlDownloadAdapter.test.js
```

No other file in the shared dirty tree was touched.

### Frozen hashes (UTF-8, BOM stripped, CRLF→LF, SHA-256)

```
c3620b52b5761371bbb577ecabafc746b5e3a041a6510efecadaedb1f96467cd   6,901  src/platform/mediaProjectActivation.js
21ffb5f5cac5c8325e3c35746946abd80ee3cb04effe11fa404a4a0de87977a6  13,556  src/platform/mediaProjectActivation.test.js
93cc7498c97d38bcaa2bbea91c5fdfadf67cd1f6f89e1403b7e39e54643523a4  31,747  src/platform/nativeUrlDownloadAdapter.js
eb2ecd63f1d2f34d8364a5de37f0a62ea31754f216467cb9b1cf4004a07df201  54,985  src/platform/nativeUrlDownloadAdapter.test.js
44a49a01768d027193a53d496bced4508bdc45cf4e5db1c638bc10108246a6c7   5,965  src/components/qualityModal/useQualityProgressTracking.js
390c631dbddd79a1b8b0d4fcccecb70a029b1bd0e088f8e6c24452c18f8a67e1   6,906  src/components/VideoRenderingSection/useVideoUpload.js
4ca260f349ec8e07db554578be20b0137835ccc27bfdffcf6c81400eb05df78e  40,318  src/hooks/useTranslationState.js
770cd001fc3f39da88e1b5f73fc7439316657e9be051a6163897ae6fe36ef8cb 267,724  scripts/check-release-readiness.js
918063784422ee1d9d21ca5b51043afdef5c63c1e0d221baa400b4bebef50a97   7,635  scripts/frontend-bundle-boundary.mjs
```

Unchanged, confirming the "do not modify" constraints held:

```
09608396dddea521821475968eb733d679131cd42acbc2cb031b7e9139badfe8  31,962  src/platform/projectService.js
6b5c78583a75ba94d75f3b931f396586955da7c8d92a8e43a9906a921e240b3f  21,202  src/platform/mediaService.js
d3b5e42b123a386ad44c2454fba0df76f1a86009ab2e70ee3c5d9c9ec20d40a2  22,346  src/components/app/handlers/downloadHandlers.js
b4048339292be7441bde609159ec3d0158f166e6b201d13d3d79047104b8b90b  59,805  apps/desktop/src-tauri/src/diagnostics.rs
```

---

## Known deviation from repository style

`src/platform/nativeUrlDownloadAdapter.js` is 890 lines, above the 600-line guideline in
`CLAUDE.md`. It was 908 before this session, and the pure/stateless parts were consolidated rather
than grown. The remaining bulk is the operation/subscriber/settlement state machine, which had just
passed an adversarial concurrency review; carving it up immediately before a release was judged the
worse trade. Flagging it rather than hiding it — the natural seam if you want it split later is a
`nativeUrlDownloadRequest.js` holding the ~190 lines of request normalization, failure constructors
and listener helpers.

---

## Reference — independently approved / frozen work (from the original handoff, unchanged)

Do not reopen these scopes unless an integrated test supplies a new concrete failure.

- **Media identity/storage migration** — v8 APPROVED. Migrations `0006` `9320cf18…`, `0007`
  `2220527a…`, `0008` `4eef288d…`.
- **Document/bulk subtitle export** — APPROVED, all 10 hashes matched.
  (`src/components/translation/index.js` is deliberately excluded from those hashes; the one-line
  i18n key change in §5(c) is inside that exclusion.)
- **Render/export capability lifecycle** — APPROVED. `renderService.js` `20320ba2…`,
  test `6bdd3861…`.
- **Diagnostics rotation** — APPROVED. `diagnostics.rs` `b4048339…`, `Cargo.toml` `9463153f…`.
  (§3(b) updated the readiness *assertion* to match this approved implementation; the Rust file
  itself was not touched.)
- Speech lifecycle/epoch/backend locking, generated-image native transport, auto-generation/segment
  ownership, settings persistence, updater/tool delivery — already in the dirty tree with focused
  reviews and tests.

## Historical first-pass review order (then execute mandatory queue A–I)

1. `src/platform/mediaProjectActivation.js` — the whole design hinges on the intent + published
   revision guards in `release()` and the pre/post publication checks.
2. `src/platform/mediaProjectActivation.test.js` — start at the three integration tests at the
   bottom; they are the regression guard for the original repro.
3. `git diff HEAD -- src/platform/nativeUrlDownloadAdapter.js` — the largest behavioural diff.
4. `git diff HEAD -- scripts/check-release-readiness.js` — three assertion changes plus two hashes.
5. §5(b) above — the one thing that is still broken and waiting on a decision from you.
