# Bounded development cache

OSG has an owned external cache manager at [`scripts/dev-cache.ps1`](../../scripts/dev-cache.ps1).
Its default root is `%LOCALAPPDATA%\OSG-Development\cache`; set
`OSG_DEV_CACHE_ROOT` or pass `-CacheRoot` to relocate it.

The hidden real-app builder uses the `e2e` lane. Canonical local Cargo/Tauri commands use `dev` or
`package`; real-workflow screenshots use `evidence`. Existing repository `target` directories remain
outside this boundary and are never adopted or pruned by the manager. They are legacy cleanup
candidates, not bytes this manager is allowed to adopt.

## Lanes

`-Action Path` initializes the ownership metadata and prints one path:

```powershell
.\scripts\dev-cache.ps1 -Action Path -Lane dev
.\scripts\dev-cache.ps1 -Action Path -Lane e2e
.\scripts\dev-cache.ps1 -Action Path -Lane package
.\scripts\dev-cache.ps1 -Action Path -Lane runtime
.\scripts\dev-cache.ps1 -Action Path -Lane evidence
.\scripts\dev-cache.ps1 -Action Path -Lane staging
```

Each `dev` and `package` group has three independent owned units: its Cargo target, immutable
frontend cache, and published application directory. `e2e` adds a fourth `assets\e2e` unit for
reusable tools, engines, and deterministic media. `runtime` returns the
`runtime\sha256` content area; each immediate child must be a lowercase 64-character SHA-256
directory. Evidence and staging accept bounded, directory-shaped runs. They do not accept
loose files at their lane root.

The root carries a unique `.osg-development-cache.json` marker. Every whole-lane prune unit
carries a matching `.osg-cache-entry.json`. The manager rejects missing or mismatched markers,
unknown root areas, unknown Cargo lanes, invalid runtime names, traversal paths, cache roots in
or above the repository, filesystem roots, and reparse points anywhere in the managed tree.
Caller paths and process paths are resolved to their authoritative Windows filesystem identity, so
8.3 names and SUBST aliases cannot bypass containment or in-use checks. A root-scoped exclusive file
lock serializes managers across Windows sessions. It never adopts a non-empty unowned directory.

Build orchestrators use the single-line JSON contract instead of deriving these paths:

```powershell
.\scripts\dev-cache.ps1 -Action Path -Lane e2e -OutputFormat Json
```

The response includes absolute `cargoTargetDir`, `frontendCacheRoot`, `appPublicationRoot`,
`assetCacheRoot`, `runtimeContentRoot`, `evidenceRoot`, and `stagingRoot` values. It also lists every path covered by
the group lease. There is deliberately no executable path: the runnable app lives in an immutable
content-addressed publication and can only be selected through its hash-verified current receipt.

## Inspect and prune

```powershell
.\scripts\dev-cache.ps1 -Action Status
.\scripts\dev-cache.ps1 -Action Prune -ProtectUnit apps-e2e
.\scripts\dev-cache.ps1 -Action Prune -ProtectLane e2e
.\scripts\dev-cache.ps1 -Action Prune -ProtectLane e2e -Apply
```

The defaults are 28 GiB and 14 inactive days. Prune is a dry run unless `-Apply` is present.
It plans complete lanes oldest-first; it never removes selected files from a Cargo tree or
from a run. `-ProtectLane` protects a complete dev/e2e/package group; `-ProtectUnit apps-e2e`
preserves the runnable publication while still allowing old Cargo, frontend, or asset lanes
to be reclaimed. The canonical npm prune commands include that application protection.

The E2E publishers apply finer retention inside their protected units. Under the exact active E2E
lease, the frontend publisher keeps its current verified immutable snapshot and one verified
previous snapshot. The application publisher independently keeps the current verified schema-v2
application and one verified previous application. During migration it may also retain the newest
verified legacy-v1 application, but older verified legacy publications are retired; corrupt,
unknown, leased, or unverifiable bytes are never guessed away. Both publishers journal publication
and retirement before mutating bytes, atomically quarantine exact owned trees, and recover only
transactions authorized by those journals.

A caller acquires one process-held lease before using any path and releases its exact token in a
`finally` block after every child process exits:

```powershell
$lease = .\scripts\dev-cache.ps1 -Action Lease -LeaseOperation Acquire `
    -Lane e2e -LeaseProcessId $PID | ConvertFrom-Json
try {
    # Build with $lease.cargoTargetDir and $lease.frontendCacheRoot, then publish
    # and verify a content-addressed application under $lease.appPublicationRoot.
}
finally {
    .\scripts\dev-cache.ps1 -Action Lease -LeaseOperation Release `
        -Lane e2e -LeaseId $lease.leaseId | Out-Null
}
```

The acquisition response is the same machine path contract plus `leaseId`,
`leaseProcessId`, and `leaseProcessCreatedUtc`. An E2E lease spans Cargo, frontend, application,
and asset units; dev/package span their three units. It always wins over age and size. The manager validates both
PID and process creation time through CIM, so a crashed build's exact owned lease is reclaimed
but PID reuse cannot impersonate it. A malformed, foreign, or unreadable lease fails closed and
is never deleted automatically.

Ordinary local work should use the root wrappers rather than raw Cargo or Vite commands. They acquire the
group lease, route `CARGO_TARGET_DIR` and every generated frontend output and Vite dependency cache into the matching external
`dev` or `package` unit, preserve the child exit code, release in `finally`, and run bounded
maintenance before and after the child. The inner `apps/desktop` Tauri scripts validate the exact
managed Cargo/frontend/application markers and shared live lease, so invoking them directly without
the root wrapper is rejected. Public `dev:vite`, `build:vite`, `build:promptdj`, and
`build:frontend` commands acquire `dev` unless they are already inside an exact dev/package lease;
Tauri hooks use separately named guarded inner commands and therefore do not nest a manager.
PromptDJ's own public build/dev commands follow the same rule. GitHub Actions calls the explicit
inner route after full runner/workspace validation. Two easy-to-spoof flags (`CI=true` and
`GITHUB_ACTIONS=true`) are never sufficient, and the local Tauri wrapper has no CI bypass:

```powershell
npm run cargo:check
npm run cargo:test
npm run cargo:clippy
npm run tauri:dev
npm run tauri:build -- --no-bundle
```

The hidden harness independently leases `evidence` from attempt creation through screenshot and
manifest finalization. Reviewable workflow folders therefore live under
`%LOCALAPPDATA%\OSG-Development\cache\evidence`, not repository `target`.
Each workflow retains its three newest attempts plus the latest successful attempt (at most four
attempts when that success is older than the newest three). The publisher
refuses unknown files and reparse points before mutating anything, records the exact removable file
inventory in a parent-owned journal, atomically quarantines each attempt, and removes the journal
last. A later leased run can therefore finish a hard-killed partial quarantine without treating
foreign bytes as owned evidence. Supported diagnostic and damaged-install routes use the same
leased parent runner; there is no direct package-script WDIO escape hatch.

The manager also checks Windows process executable paths and command lines immediately before
destructive work. If CIM inspection fails, deletion fails closed. If protected, leased, or
in-use bytes alone exceed the cap, prune returns nonzero instead of weakening protection.

Deletion is recoverable: the manager first atomically renames the complete owned lane into the
cache root's exact owned `.trash` directory, then deletes only the validated trash child. A
crash or locked file can leave that renamed child behind. The next prune validates its original
lane marker and resumes deletion. Unknown or leased trash is retained and causes no broad
filesystem operation.

## Product runtime staging

Large temporary product operations use the same bounded ownership model, but they do not share the
development cache manager or its deletion authority. The desktop creates one private
`RuntimeStagingAuthority` beneath its application cache and passes that authority into downloads,
native-tool and engine installation, media imports, media-pipeline transforms, render/export jobs,
ASR, narration, and their worker compiler caches.

Each attempt records an authenticated central journal before publishing its random staging name.
Directory identity is pinned by Windows volume and file ID, journals are locked for the complete
attempt lifetime, and recovery removes only an exact owned entry whose journal, kind, target root,
and physical identity still agree. Reparse points, renamed roots, malformed journals, unknown
legacy prefixes, and offline or replaced destinations are preserved and refused rather than
guessed away. Successful operations publish durable output before their attempt guard is dropped;
failed, cancelled, or hard-killed operations are reconciled on the next authority startup.

Pre-journal residue is deliberately not adopted. It can be inspected and removed by an owner, but
the application never turns a familiar filename prefix into deletion authority.

## Contract tests

The test suite uses only isolated temporary roots and never invokes Cargo:

```powershell
.\scripts\dev-cache.test.ps1
```

It covers ownership and lane paths, the 28 GiB/14-day defaults, cap and age ordering, dry-run behavior, leases, real
process-command-line detection, fail-closed CIM errors, explicit protection, unknown bytes,
runtime-address validation, traversal and root rejection, reparse points, interrupted-trash
recovery, crash-stale lease reclamation, PID-reuse defense, corrupt-lease retention, cross-session
locking, and Windows physical-path aliases.
