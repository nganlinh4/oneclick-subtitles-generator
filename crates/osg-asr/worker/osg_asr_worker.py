"""OSG local-ASR worker protocol v1.

This module is launched by the Rust supervisor from a pinned per-engine virtual
environment. It never opens a socket. Stdout is reserved for 32-bit big-endian
length-prefixed JSON frames; library output is redirected to bounded stderr.
"""

from __future__ import annotations

import gc
import json
import os
import struct
import sys
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 64 * 1024

# Preserve a private handle to the original stdout, then redirect file descriptor
# 1 itself. This also catches native libraries which bypass Python's sys.stdout.
_protocol_fd = os.dup(sys.stdout.fileno())
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
PROTOCOL_OUT = os.fdopen(_protocol_fd, "wb", buffering=0)

QWEN_LANGUAGES = {
    "zh": "Chinese",
    "en": "English",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "pt": "Portuguese",
    "ru": "Russian",
    "es": "Spanish",
}
CJK_LANGUAGES = {"Chinese", "Japanese", "Cantonese"}
_DLL_DIRECTORY_HANDLES: list[Any] = []


def _read_exact(size: int) -> bytes | None:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame() -> dict[str, Any] | None:
    header = _read_exact(4)
    if header is None:
        return None
    length = struct.unpack(">I", header)[0]
    if length <= 0 or length > MAX_REQUEST_BYTES:
        raise ValueError("invalid frame length")
    body = _read_exact(length)
    if body is None:
        raise ValueError("truncated frame")
    value = json.loads(body.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    return value


def write_frame(value: dict[str, Any]) -> None:
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    PROTOCOL_OUT.write(struct.pack(">I", len(body)))
    PROTOCOL_OUT.write(body)
    PROTOCOL_OUT.flush()


def emit(request_id: int, sequence: int, event: str, **fields: Any) -> None:
    write_frame(
        {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "sequence": sequence,
            "event": event,
            **fields,
        }
    )


def safe_path(value: object, *, directory: bool) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("invalid path")
    path = Path(value)
    if not path.is_absolute() or (directory and not path.is_dir()) or (not directory and not path.is_file()):
        raise ValueError("path unavailable")
    return str(path)


def bootstrap_torch() -> tuple[Any, bool]:
    import torch

    torch_lib = Path(torch.__file__).parent / "lib"
    if torch_lib.is_dir():
        if hasattr(os, "add_dll_directory"):
            try:
                # The returned handle removes the directory when it is closed
                # or collected. Retain it for the worker lifetime so delayed
                # ONNX/CTranslate2 DLL loads cannot silently lose CUDA.
                _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(torch_lib)))
            except OSError:
                pass
        os.environ["PATH"] = str(torch_lib) + os.pathsep + os.environ.get("PATH", "")
    return torch, bool(torch.cuda.is_available())


def find_ort_backend(value: object, ort: Any) -> str | None:
    seen: set[int] = set()
    stack = [value]
    while stack:
        current = stack.pop()
        marker = id(current)
        if marker in seen:
            continue
        seen.add(marker)
        if isinstance(current, ort.InferenceSession):
            providers = current.get_providers()
            if "CUDAExecutionProvider" in providers:
                return "cuda"
            if "DmlExecutionProvider" in providers:
                return "direct_ml"
            if "CoreMLExecutionProvider" in providers:
                return "core_ml"
            return "cpu"
        try:
            stack.extend(vars(current).values())
        except TypeError:
            pass
    return None


class Runtime:
    def __init__(self) -> None:
        self.signature: tuple[str, str, str | None] | None = None
        self.model: object | None = None
        self.backend = "cpu"

    def ensure_loaded(self, request: dict[str, Any]) -> None:
        engine = request.get("engine")
        model_path = safe_path(request.get("modelPath"), directory=True)
        aligner_value = request.get("alignerPath")
        aligner_path = safe_path(aligner_value, directory=True) if aligner_value is not None else None
        signature = (engine, model_path, aligner_path)
        if self.signature is not None:
            if signature != self.signature:
                raise ValueError("runtime configuration changed")
            return

        if engine == "parakeet":
            self._load_parakeet(model_path)
        elif engine in {"faster-whisper-turbo", "faster-whisper-large-v3"}:
            self._load_faster_whisper(model_path)
        elif engine in {"qwen3-asr-1.7b", "qwen3-asr-0.6b"}:
            if aligner_path is None:
                raise ValueError("aligner required")
            self._load_qwen(model_path, aligner_path)
        else:
            raise ValueError("unknown engine")
        self.signature = signature

    def _load_parakeet(self, model_path: str) -> None:
        try:
            bootstrap_torch()
        except Exception:
            pass
        import onnxruntime as ort
        from onnx_asr import load_model

        if hasattr(ort, "preload_dlls"):
            try:
                ort.preload_dlls(cuda=True, cudnn=True, msvc=True)
            except Exception:
                pass
        available = set(ort.get_available_providers())
        preferred = [
            "CUDAExecutionProvider",
            "DmlExecutionProvider",
            "CoreMLExecutionProvider",
            "CPUExecutionProvider",
        ]
        providers = [provider for provider in preferred if provider in available]
        if "CPUExecutionProvider" not in providers:
            providers.append("CPUExecutionProvider")
        # onnx-asr's first positional argument is the model *kind*, not the
        # local directory. Passing the directory there makes Windows paths look
        # like an unknown model name and can also re-enable Hub resolution.
        # Keep the reviewed model identity fixed and pass the package-relative
        # directory through the dedicated offline `path` argument.
        model = load_model(
            "nemo-parakeet-tdt-0.6b-v3",
            model_path,
            providers=providers,
        ).with_timestamps()
        self.backend = find_ort_backend(model, ort) or "cpu"
        self.model = model

    def _load_faster_whisper(self, model_path: str) -> None:
        _, cuda = bootstrap_torch()
        from faster_whisper import WhisperModel

        device = "cuda" if cuda else "cpu"
        compute_type = "float16" if cuda else "int8"
        self.model = WhisperModel(model_path, device=device, compute_type=compute_type)
        self.backend = "cuda" if cuda else "cpu"

    def _load_qwen(self, model_path: str, aligner_path: str) -> None:
        torch, cuda = bootstrap_torch()
        from qwen_asr import Qwen3ASRModel

        if cuda:
            device = "cuda:0"
            dtype = torch.bfloat16
            self.backend = "cuda"
        elif sys.platform == "darwin" and torch.backends.mps.is_available():
            device = "mps"
            dtype = torch.float16
            self.backend = "metal"
        else:
            device = "cpu"
            dtype = torch.float32
            self.backend = "cpu"
        self.model = Qwen3ASRModel.from_pretrained(
            model_path,
            dtype=dtype,
            device_map=device,
            max_new_tokens=448,
            forced_aligner=aligner_path,
            forced_aligner_kwargs={"dtype": dtype, "device_map": device},
        )

    def transcribe(self, request: dict[str, Any]) -> tuple[str, str | None, list[dict[str, Any]], bool]:
        if self.model is None or self.signature is None:
            raise RuntimeError("model unavailable")
        input_path = safe_path(request.get("inputPath"), directory=False)
        duration_ms = request.get("inputDurationMs")
        if not isinstance(duration_ms, int) or duration_ms <= 0:
            raise ValueError("invalid duration")
        language = request.get("language")
        if language is not None and (not isinstance(language, str) or len(language) != 2):
            raise ValueError("invalid language")
        engine = self.signature[0]
        if engine == "parakeet":
            return self._transcribe_parakeet(input_path, duration_ms)
        if engine in {"faster-whisper-turbo", "faster-whisper-large-v3"}:
            return self._transcribe_faster_whisper(input_path, language)
        return self._transcribe_qwen(input_path, language)

    def _transcribe_parakeet(self, input_path: str, duration_ms: int) -> tuple[str, None, list[dict[str, Any]], bool]:
        result = self.model.recognize(input_path)
        tokens = list(result.tokens or [])
        timestamps = list(result.timestamps or [])
        grouped: list[dict[str, Any]] = []
        current: list[str] = []
        current_start: float | None = None
        for token, timestamp in zip(tokens, timestamps, strict=False):
            if current_start is None:
                current_start = float(timestamp)
            if token.startswith(" ") and current:
                grouped.append({"text": "".join(current).strip(), "start": current_start})
                current = [token]
                current_start = float(timestamp)
            else:
                current.append(token)
        if current:
            grouped.append({"text": "".join(current).strip(), "start": current_start or 0.0})
        duration = duration_ms / 1000.0
        words: list[dict[str, Any]] = []
        for index, word in enumerate(grouped):
            following = grouped[index + 1]["start"] if index + 1 < len(grouped) else duration
            estimated = word["start"] + len(word["text"]) * 0.07
            words.append(
                {
                    "text": word["text"],
                    "startSeconds": word["start"],
                    "endSeconds": min(estimated, following, duration),
                }
            )
        return str(result.text or "").strip(), None, words, False

    def _transcribe_faster_whisper(self, input_path: str, language: str | None) -> tuple[str, str | None, list[dict[str, Any]], bool]:
        segments, info = self.model.transcribe(
            input_path,
            language=language or None,
            word_timestamps=True,
            beam_size=5,
            vad_filter=False,
        )
        text_parts: list[str] = []
        words: list[dict[str, Any]] = []
        for segment in segments:
            text_parts.append(segment.text)
            for word in segment.words or []:
                text = str(word.word or "").strip()
                if text:
                    words.append(
                        {
                            "text": text,
                            "startSeconds": float(word.start),
                            "endSeconds": float(word.end),
                        }
                    )
        detected = getattr(info, "language", None)
        return "".join(text_parts).strip(), detected if isinstance(detected, str) and len(detected) == 2 else None, words, False

    def _transcribe_qwen(self, input_path: str, language: str | None) -> tuple[str, str | None, list[dict[str, Any]], bool]:
        qwen_language = QWEN_LANGUAGES.get(language) if language else None
        result = self.model.transcribe(
            audio=[input_path], language=qwen_language, return_time_stamps=True
        )[0]
        items = list(result.time_stamps) if getattr(result, "time_stamps", None) else []
        words = [
            {
                "text": str(item.text),
                "startSeconds": float(item.start_time),
                "endSeconds": float(item.end_time),
            }
            for item in items
        ]
        detected_name = getattr(result, "language", None)
        detected = next((code for code, name in QWEN_LANGUAGES.items() if name == detected_name), None)
        return str(result.text or "").strip(), detected, words, detected_name in CJK_LANGUAGES


def main() -> None:
    runtime = Runtime()
    while True:
        try:
            request = read_frame()
        except Exception as error:
            print(f"ASR protocol read failed: {type(error).__name__}", file=sys.stderr)
            return
        if request is None:
            return
        request_id = request.get("requestId")
        if not isinstance(request_id, int) or request_id <= 0 or request.get("protocolVersion") != PROTOCOL_VERSION:
            return
        sequence = 0
        try:
            if runtime.signature is None:
                emit(request_id, sequence, "phase", phase="model_loading")
                sequence += 1
                runtime.ensure_loaded(request)
            else:
                runtime.ensure_loaded(request)
            emit(request_id, sequence, "phase", phase="transcribing")
            sequence += 1
            transcript, language, words, join_without_spaces = runtime.transcribe(request)
            emit(request_id, sequence, "phase", phase="finalizing")
            sequence += 1
            emit(
                request_id,
                sequence,
                "complete",
                transcript=transcript,
                language=language,
                backend=runtime.backend,
                words=words,
                joinWithoutSpaces=join_without_spaces,
            )
        except ValueError as error:
            print(f"ASR request rejected: {type(error).__name__}", file=sys.stderr)
            emit(request_id, sequence, "error", code="invalid_request")
        except Exception as error:
            print(f"ASR inference failed: {type(error).__name__}", file=sys.stderr)
            code = "model_load_failed" if runtime.signature is None else "inference_failed"
            emit(request_id, sequence, "error", code=code)
            runtime.model = None
            runtime.signature = None
            gc.collect()


if __name__ == "__main__":
    main()
