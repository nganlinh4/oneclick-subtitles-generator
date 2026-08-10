# `osg-asr`

Native ownership for OSG's local speech-recognition jobs. The machine-learning
runtimes remain in their pinned Python environments, while Rust owns the public
types, normalized-audio validation, process lifetime, cancellation, timeouts,
bounded IPC, output validation, subtitle segmentation, and SRT generation.

The worker is not a server. It has no listening socket and receives one framed
request at a time over private stdin/stdout pipes. It starts lazily on the first
job, keeps that job's model warm for subsequent jobs, and is killed as a process
tree after cancellation, timeout, malformed output, or runtime failure.

## Legacy capability audit

The prior Electron/Python topology exposed five local choices:

- NVIDIA Parakeet TDT 0.6B V3 through `onnx-asr`;
- Faster-Whisper large-v3-turbo and large-v3 through CTranslate2;
- Qwen3-ASR 0.6B and 1.7B with the Qwen forced aligner.

All five produce a transcript plus subtitle segments. Faster-Whisper and Qwen
accept a forced language; Parakeet is auto-detect only. Faster-Whisper and Qwen
provide word ends, while Parakeet's token starts require bounded end-time
estimation. The old frontend sends pre-sliced WAV audio and applies sentence,
word-count, or character-count segmentation.

Native Rust inference was rejected for this migration boundary: no single mature
Rust stack currently preserves all three runtime families, their pinned model
formats, GPU-provider behavior, forced alignment, and installed weights. Binding
each C/C++ runtime in-process would also put GPU allocator crashes inside the
desktop process. A supervised worker preserves capability while removing the
localhost/CORS/base64 layers and containing runtime crashes.

The foundation deliberately does not install models, invent percentage progress,
or accept arbitrary encoded media. Callers normalize media to 16 kHz mono PCM16
WAV first, resolve installed local model directories, and run installation as a
separate durable job.

## Cross-platform runtime implications

- Windows can use CUDA for all three runtime families, DirectML for Parakeet when
  its ONNX Runtime build provides it, and CPU fallback.
- Linux can use CUDA or CPU. CTranslate2 does not provide a Metal backend.
- macOS can use ONNX Runtime's CoreML provider when installed, Qwen through
  PyTorch MPS, and CPU for Faster-Whisper. Provider reporting comes from the
  runtime actually selected; the host never claims acceleration from GPU
  detection alone.

The worker is launched directly from an absolute executable path without a
shell. Its environment is allowlisted and model libraries run offline. Any
timeout, cancellation, invalid event sequence, oversized frame, stdout logging,
worker crash, or malformed timestamp invalidates the warm session and kills its
whole process tree. Stderr is drained continuously but retains only a bounded
private diagnostic tail.
