# Rewrite architecture notes

The native rewrite architecture is documented in [../../ARCHITECTURE.md](../../ARCHITECTURE.md),
with trust boundaries in [../../SECURITY.md](../../SECURITY.md).

## Rewrite invariants

- Replace the former Electron and localhost service topology behind existing interactions; do not
  carry its endpoints, globals, caches, port managers, or process ownership into the native core.
- Keep the repository-root `src/` and `public/` trees as the canonical visual source. A backend
  rewrite is not permission to restyle or reorder the product.
- Keep project, media, subtitle, artifact, job, setting, and credential ownership in Rust. The
  WebView receives typed snapshots and opaque identifiers.
- Make long-running work bounded, observable, cancellable, and recoverable where durability is
  part of the operation contract.
- Isolate model runtimes behind supervised private worker protocols. Optional runtimes must fail
  closed when their reviewed delivery catalogs are empty.
- Treat source compilation and release packaging as different readiness levels. A build is not a
  release until its target-specific tools, models, notices, updater key, packaging, and runtime
  smoke tests all pass.

At this checkpoint the FFmpeg/ffprobe, ASR, speech, and Remotion release lists are deliberately
empty. yt-dlp and Deno have reviewed direct-upstream deliveries, but are not bundled. The updater
public key is a placeholder, macOS/Linux still need real-device validation, and the repository
owner has not yet selected the root project license or approved the third-party-notice and
corresponding-source policy (`THIRD_PARTY_NOTICES.md` is absent). These are release blockers, not
reasons to reintroduce a legacy service or bypass a readiness gate.

The existing URL-inspection interaction is the only automatic entry into native-tool delivery. It
checks typed status, asks the user to approve the exact yt-dlp/Deno package-and-license batch,
reports bounded progress in the existing toast panel, and exposes cancellation. It never runs at
startup. Because download runtimes and their executable leases are constructed at Tauri startup,
a successful install stops with an explicit restart requirement rather than retrying in stale
state. The same preflight refuses to offer FFmpeg/ffprobe while that delivery catalog is empty.

Speech packaging also remains blocked on transitive dependency/notices, offline and per-target
proof, provider-terms review, and a decision about the `CC-BY-NC-4.0` F5TTS v1 base weights. Those
weights are not a general commercial-capable default without a different model or an explicit
owner-approved product policy and acceptance flow.

## Compatibility boundary

OSG preserves user-visible workflows and supported user artifacts, not legacy implementation
details. The native migration path accepts bounded settings, provider credentials, and supported
media/subtitle artifacts from an explicitly selected old data directory. It intentionally ignores
transient flags, caches, paths, URLs, provider handles, and other machine-specific state.

The rewrite retains SRT and supported legacy subtitle JSON import, millisecond timing, durable
project revisions, and source-preserving migration. It does not promise compatibility with the old
HTTP APIs or installer scripts.

Editor undo/redo is durable only for the canonical subtitle fields carried by `ProjectSnapshot`:
track label/origin/identity and cue/source identity, text, and millisecond start/end timing. React
updates remain optimistic, while a single native queue commits text, insert/delete, merge/split,
timing/range, reset, checkpoint-jump, smart-timing, and grouped streaming-merge edits in the same
order. A separate per-project editor-track cursor stores at most 256 canonical track states. Its
monotonic `historyVersion` is independent from the whole project's `stateVersion`; commit, undo,
and redo guard the history version and exact bounded revision reason in the same SQLite
transaction. Save operations that contain the same canonical track are revision no-ops.

Text renders immediately but becomes one durable revision after 500 ms of inactivity; pending text
is flushed before navigation, another edit kind, save, or unmount. The native queue is serialized
and bounded to 16 operations, 128 MiB total retained snapshot data, and 64 MiB per state. Saturation
or any native write/navigation failure rejects the current save barrier and performs an
authoritative load/status reconciliation before a later save may proceed. The responsive local
undo/redo mirror retains at most 255 combined edges and 256 MiB, matching the native cursor's 256
states; farther entries are evicted from memory and remain reachable through native navigation.
Session checkpoints are separately limited to four entries and 128 MiB.

The checkpoint list itself, original/saved comparison markers, translations, selection, sticky
mode, playback state, and other presentation state are not part of `ProjectSnapshot` and remain
session-local. An undo restores canonical rows and therefore does not claim to restore those
fields. Browser preview keeps its existing in-memory undo/redo behavior and never invokes the
native project bridge.

Track navigation always loads the latest whole-project state and replaces only the selected editor
track inside its transaction. Newer project metadata, media, options stored outside the snapshot,
and every other subtitle track remain untouched. A new lyric edit after undo deletes only the
abandoned editor redo branch. If another writer changes the selected track itself, status reports a
diverged cursor, navigation fails closed, and the next edit can atomically rebase from the exact
authoritative track; stale writers cannot overwrite it.

Whole-project revision ancestry is also capped at 256 states. Branching deletes abandoned redo
rows transactionally, and startup reconciliation trims legacy overlong or detached revision graphs
before normal project access.

## Durable job retention

Durable job rows are not age-pruned yet. Artifacts reference jobs through a foreign key, while
speech, render, and package-operation manifests use opaque job UUIDs as settings keys. Deleting a
job without a feature-owned manifest lifecycle could therefore detach provenance or make a valid
result unreachable. The database keeps those rows intact, restores every non-terminal job plus the
newest 256 terminal jobs into memory, and lazily loads an older terminal job when a caller presents
its opaque UUID. The registry compacts back to 256 resident terminal jobs after terminal
transitions, lazy reads, and listings; a terminal entry held by concurrent work is never evicted and
is reconsidered after that work releases it. The WebView job listing independently keeps every
resident active job and at most 256 terminal jobs; it fails closed if active work itself exceeds its
256-job safety bound.

Future on-disk pruning must be one transaction per feature: prove the job is terminal, release or
retarget every artifact reference, remove the corresponding typed result/operation manifest, and
only then delete the job. A time-only or count-only `DELETE FROM jobs` policy is not safe.
