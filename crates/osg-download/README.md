# osg-download

`osg-download` is the native download boundary for OSG. It wraps one managed
`yt-dlp` process adapter; it does not expose command arguments, cookie paths,
or output paths to serialized callers.

## Trust boundary

The intended native flow is:

1. Resolve a configured or bundled `yt-dlp` executable. PATH lookup is off
   unless native startup explicitly opts in.
2. Validate the URL and inspect it into a path-free `MediaInventory`.
3. Convert an inventory entry into `SelectedFormat` / `SelectedSubtitle`
   capabilities. These types cannot be deserialized and are bound to the exact
   inspected URL, including its query.
4. Construct `DownloadDestination` and `FfmpegDirectory` from native paths.
5. Build a `DownloadPlan`, then run it with a bounded `RunControl`.

Use `UrlPolicy::SupportedSitesOnly` for IPC-facing requests. The
`NativePublicInternet` policy intentionally supports arbitrary public hosts and
must only be reachable from a deliberate native workflow. Both policies reject
credentials, non-default ports, local/private/link-local destinations, mixed
public/private DNS results, and repeat DNS checks immediately before launch.
Like any external downloader, yt-dlp may make extractor-controlled secondary
requests after the initial URL check; OS-level egress policy is required when a
deployment needs a hard network sandbox.

Artifacts are produced in a random same-directory staging folder, verified as
regular nonempty files, and atomically published without replacing an existing
file. Cancellation and timeouts terminate the managed process group/job.

## Workspace integration

This directory is temporarily a standalone workspace so it can be tested while
the root rewrite is changing concurrently. To integrate it:

1. Remove the local `[workspace]` stanza from `Cargo.toml`.
2. Delete this directory's `Cargo.lock`.
3. Add `crates/osg-download` to the root workspace members and move or inherit
   dependency versions according to the root workspace convention.
4. Pass the bundled FFmpeg directory resolved by the native media layer into
   `DownloadEngine::with_ffmpeg`.

Verification:

```text
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
```
