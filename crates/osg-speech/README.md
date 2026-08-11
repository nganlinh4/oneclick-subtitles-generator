# osg-speech

`osg-speech` is the native boundary for narration synthesis, reference-voice
conversion, deterministic audio edits, and subtitle-timeline alignment. It is a
foundation crate: heavyweight ML/provider implementations remain isolated in a
trusted worker, while validation, lifecycle, timing, and publication live in
Rust.

The crate deliberately has no WebView-facing deserializers for paths, process
programs, process arguments, text capabilities, or secrets. A Tauri command
must construct these values from an approved native project/file capability.

## Legacy capability audit

The rewrite audit covered both implementations of Edge/gTTS, the F5 service,
the Chatterbox service and UI client, Gemini Live narration, reference handling,
every narration audio route, and the aligned-audio pipeline.

| Legacy area | Useful behavior retained by this crate | Legacy liability removed at this boundary |
| --- | --- | --- |
| F5-TTS | Reference audio and supplied/automatic reference transcription; custom model ID; rate; 8/16/32/64 NFE; sway; guidance; seed; silence removal; 1 s F5 reference padding plan | Per-request model reload, raw model/reference paths from HTTP, API key in request JSON, text/path logging, ad-hoc GPU cleanup |
| Chatterbox | English/multilingual language selection, reference voice, exaggeration, CFG, fixed worker-side model behavior, and voice conversion | Unauthenticated localhost FastAPI/CORS surface, multipart temp-file handling, UI-owned health/wake-up retries |
| Edge TTS | Voice inventory, voice selection, rate/volume/pitch, MP3 artifacts, batched native orchestration | Generated temporary Python source, raw string controls, SSML interpolation, per-subtitle process spawn, unbounded child output |
| gTTS | Language inventory through the generic inventory command, all 13 legacy TLDs, slow mode, MP3 artifacts | Generated temporary Python source, arbitrary language/domain strings, temporary-file leakage, per-subtitle process spawn |
| Gemini Live TTS | Typed model/voice/language, native-only provider credential, WAV artifact contract, app-controlled parallel worker instances | Browser-held API keys, browser WebSocket pool, base64 PCM round trip, prompt/text logging, cancellation that only cleared a JS flag |
| Reference audio | Canonical native file capabilities, approved-root option, change detection, segment trim/resample/stereo/padding plan | 5 GiB multipart/base64 HTTP uploads, returned absolute paths, common-install/PATH FFmpeg guessing, overwrite-by-default |
| Speed/trim | 0.25x-4x typed speed, normalized trim, timestamp reset, FFmpeg-safe 0.5x-2x tempo-stage decomposition, deterministic output duration | Inconsistent endpoint limits, in-place mutation and `backup_` conventions, raw filenames and filter construction in routes |
| Duration/metadata | Typed measured durations on artifacts and deterministic plan inputs | JSON sidecars and duplicated WAV/ffprobe duration logic; exact probing belongs to `osg-media` |
| Alignment | Stable integer-microsecond ordering, measured clip durations, duplicate rejection, 300 ms tolerance, 200 ms recovery overlap, 250 ms tail, monotonic timeline frontier, path-free stats | Float drift, misleading “distributed gap” math that did not move earlier clips, timeline-frontier regression, verbose path dumps |
| Aligned output | Render-ready clip plan with native asset capabilities | Huge FFmpeg command/filter scripts, hardcoded gain, weak cancellation, sync/async job duplication; execution belongs to `osg-media` |
| Storage/export | Verified, same-directory staging and no-clobber publication | Raw audio-serving/range routes, ZIP endpoints, cleanup endpoints, directory enumeration in error logs; these belong to Tauri project storage |

The audit also covered subtitle grouping and F5 text normalization. Semantic
grouping and optional number/date rewriting use Gemini and therefore belong in
the centralized Gemini provider, followed by strict group coverage/order
validation. They are not silently performed inside speech synthesis.

## Architecture

### Native domain

- `SpeechText`, identifiers, language/model IDs, all numeric controls, time,
  trim and speed values are validated and bounded.
- `AudioAsset` and `SpeechOutput` are canonical native capabilities. They are
  not serializable, and their debug output is redacted.
- `AlignmentPlan`, `AudioEditPlan`, and `ReferencePreparationPlan` contain no
  command strings. The media layer translates their closed filter enums.
- Every public error is path-, text-, worker-output-, and secret-safe.

### Managed workers

One `LazySpeechWorker` owns one backend-specific persistent child. Model load is
lazy and can remain warm across requests. One operation is in flight per worker;
bounded parallelism is achieved by constructing a small native pool, not by
sharing a non-reentrant Python model across threads.

The worker is resolved from an explicitly configured executable/bootstrap or
approved bundled roots. PATH lookup is opt-in and only searches the fixed
`osg-speech-worker` name. Spawn arguments are fixed by the crate:

```text
[for Python: -I -B -u -X utf8 <trusted bootstrap>]
--stdio-worker --protocol-version 1 --backend <closed backend>
```

There is no shell and no caller-provided argument vector. A provider credential,
when required, is passed only as `OSG_SPEECH_PROVIDER_SECRET`.
Python isolated mode ignores user-site/PYTHON* injection, and the host removes
ambient Gemini credential variables before optionally setting that fixed secret.

Chatterbox voice conversion is restricted further because the pinned 0.1.7
upstream `from_local` implementation otherwise performs a bare
`torch.load(conds.pt)`. The worker accepts that loader only when its reviewed
shape makes the Torch call interceptable, the installed Torch API explicitly
supports `weights_only`, and `conds.pt` resolves to the managed model root. A
worker-local proxy then permits exactly one load of that exact file, verifies
the pinned 107,374-byte/SHA-256 inventory, freezes the verified bytes in a
bounded in-memory stream, and forces `weights_only=True` on that stream. An
aliased, imported, closure-captured, multi-load, wrong-path, custom-pickle,
explicitly unsafe, or download-capable loader fails with the static
`model_unavailable` code before an unguarded deserializer can run. The proxy is
removed immediately after model construction, so ordinary Chatterbox reference
TTS and other Torch consumers retain their pinned behavior.

The IPC transport is a 4-byte big-endian length followed by one UTF-8 JSON
object. Frames are limited to 1 MiB. The first frame must be a matching `hello`.
Every later response carries the protocol version and request ID. The reader
queue is bounded to 64 frames, stderr retains at most 64 KiB, and unknown worker
error text is reduced to the static `worker_error` code.

After `hello`, the Python adapter keeps the protocol on a duplicated descriptor
and redirects process-level stdout/stderr to the null sink. This prevents native
ML/CUDA libraries that bypass `sys.stdout` from corrupting IPC or leaking input.

Cancellation and timeout cover queue admission, startup, model loading,
synthesis, encoding, and response handling. The child is placed in a process
group/job object through `command-group`; cancellation, protocol failure, and
timeout discard the full worker tree. A worker rejection is the only operation
error that keeps the session warm.

### Artifact contract

Workers write only to a random, same-directory staged path selected by Rust.
Rust verifies regular-file type, exact reported size, bounds, stream parameters,
format signature, and (for WAV) RIFF chunks and measured duration. Publication
uses a no-clobber hard link when supported and a `create_new` copy fallback.
Malformed artifacts are removed and invalidate the worker.

## Worker adapter contract

A packaged worker should:

1. Keep stdout exclusively for framed protocol data and send `hello` before
   importing/loading a heavyweight model.
2. Validate the fixed backend again and dispatch only the closed commands
   `synthesize`, `prepare_reference`, `convert_voice`, `list_voices`, and
   `shutdown`.
3. Load a backend/model lazily, retain it for later requests, and release it on
   EOF/shutdown.
4. Treat incoming native paths as opaque files selected by the host. It must not
   accept extra paths, URLs, commands, or model filenames hidden in settings.
5. Write one complete artifact to `output_path`, flush/close it, then send a
   `complete` frame with bytes, duration, rate, and channel count.
6. Return only documented static error codes. Diagnostics may go to stderr but
   must never contain narration text, credentials, or full native paths.

Python ML stacks should be packaged as a fixed executable (preferred) or a
fixed `.py` bootstrap beside a bundled Python environment. Do not recreate the
legacy pattern of generating Python source at runtime.

## Competing architecture review

The managed-runtime design uses persistent
provider workers, typed per-request profiles, generation-based cancellation,
warm Gemini transport, and a clear distinction between collected artifacts and
immediate playback. This crate keeps those principles while tightening the
boundary with bounded queues/frames, redacted errors, integer timing,
no-clobber artifacts, and process-tree termination.

The toolbox's global unbounded queues, float timeline calculations, optional
aligner command from an environment string, and path/text-heavy logging were
not copied. Playback and waveform generation are separate media/UI concerns.

## Integration

1. Bundle the verified `worker/osg_speech_worker.py` bootstrap and compatible,
   pinned backend runtimes for each release target. F5 and Chatterbox model
   registries must continue resolving `ModelId` internally.
2. Store worker programs and credentials in native application state. Tauri
   commands accept durable artifact IDs, not native paths or process data.
3. Translate edit/reference/alignment plans through `osg-media` and use that
   crate for exact ffprobe metadata and final aligned WAV/M4A rendering.
4. Put retries, bounded worker-pool sizing, batch result persistence, semantic
   grouping, and localized UI messages in native orchestration above this crate.

## Deliberate remaining parity gaps

- The unified Python adapter implements F5, Chatterbox TTS/voice conversion,
  Edge TTS, gTTS, Gemini Live audio, voice inventory, and F5 reference
  preparation. Release builds still fail closed until compatible pinned Python
  runtimes and packages are installed or bundled for the selected backend.
- Model install/update/remove/download and GPU/device selection remain outside
  the crate. The legacy unmanaged repository copy at
  `models/chatterbox_weights/conds.pt` was removed with the old setup/runtime
  topology; the worker neither reads nor adopts that path. The reviewed speech
  upstream lock retains its exact size and SHA-256. Every future Chatterbox
  delivery must inventory that file with the rest of the pinned model payload,
  install it beneath the package's declared model root, and pass archive,
  per-file, receipt, and exact-tree verification before worker launch.
- The worker measures MP3 frame metadata and the host verifies its container
  signature and bounded reported values. Exact M4A probing remains an
  `osg-media` responsibility.
- Semantic subtitle grouping, Gemini number/date normalization, retry/key
  rotation, and provider-specific rate limiting belong to `osg-gemini` plus job
  orchestration.
- Playback, waveform caches, HTTP range compatibility, ZIP export, example-voice
  catalog storage, and old-output cleanup belong to native media/project APIs.
- The aligned render itself is intentionally not duplicated here. This crate
  produces the deterministic render plan; `osg-media` owns FFmpeg execution.
- macOS signing/quarantine, Linux executable permissions, GPU runtime packaging,
  and actual provider/model smoke tests remain release-matrix work. Required
  tests use only the system Python standard library and never depend on FFmpeg,
  a model, a network, or a provider key.

## Verification

```powershell
cargo fmt --manifest-path crates/osg-speech/Cargo.toml -- --check
cargo clippy --manifest-path crates/osg-speech/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path crates/osg-speech/Cargo.toml --all-targets
python -B -m unittest crates/osg-speech/tests/python_worker_contract.py -v
```

The test worker is compiled directly with the active Rust toolchain. Tests cover
all five backends, guarded Chatterbox conversion (including hostile unsafe,
aliased, and download-capable loaders), lazy reuse, typed progress, secret and
shell-metacharacter handling, strict framing, malformed IDs/frames/artifacts,
bounded stderr, no-clobber publication, cancellation, timeout, unexpected exit,
competing-request cancellation isolation, and descendant process-tree termination
on Windows (and Unix when run there). The desktop bridge separately verifies
durable artifact resolution after deleting the source and reopening its database;
the frontend contract tests durable result recovery after a WebView reconnect.
