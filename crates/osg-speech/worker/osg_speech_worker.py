#!/usr/bin/env python3
"""Supervised stdio adapters for OSG speech backends.

Stdout is reserved for the length-delimited protocol.  The host supplies all
paths and the only provider credential through a fixed environment variable.
The worker never starts a server, accepts a URL, or writes a caller-selected
log message.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import dis
import hashlib
import io
import inspect
import json
import os
import struct
import sys
import wave
from pathlib import Path
from typing import Any, BinaryIO


PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
MAX_TEXT_BYTES = 16 * 1024
WORKER_VERSION = "native-1.0"
BACKENDS = {"f5_tts", "chatterbox", "edge_tts", "gtts", "gemini_live"}
FORMATS = {"f5_tts": "wav", "chatterbox": "wav", "edge_tts": "mp3", "gtts": "mp3", "gemini_live": "wav"}
GEMINI_MODELS = {
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-native-audio-preview-12-2025",
}
GEMINI_VOICES = (
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
)
GEMINI_VOICE_GENDERS = {
    "Achernar": "female", "Achird": "male", "Algenib": "male",
    "Algieba": "male", "Alnilam": "male", "Aoede": "female",
    "Autonoe": "female", "Callirrhoe": "female", "Charon": "male",
    "Despina": "female", "Enceladus": "male", "Erinome": "female",
    "Fenrir": "male", "Gacrux": "female", "Iapetus": "male",
    "Kore": "female", "Laomedeia": "female", "Leda": "female",
    "Orus": "male", "Puck": "male", "Pulcherrima": "female",
    "Rasalgethi": "male", "Sadachbia": "male", "Sadaltager": "male",
    "Schedar": "male", "Sulafat": "female", "Umbriel": "male",
    "Vindemiatrix": "female", "Zephyr": "female", "Zubenelgenubi": "male",
}
CHATTERBOX_LANGUAGES = frozenset({
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja",
    "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
})
CHATTERBOX_CONDITIONALS_BYTES = 107_374
CHATTERBOX_CONDITIONALS_SHA256 = (
    "6552d70568833628ba019c6b03459e77fe71ca197d5c560cef9411bee9d87f4e"
)

_ORIGINAL_STDOUT = sys.stdout
_ORIGINAL_STDERR = sys.stderr
_PROTOCOL_OUT: BinaryIO = os.fdopen(os.dup(sys.stdout.buffer.fileno()), "wb", buffering=0)
_OUTPUT_SINK: Any = None
_F5_MODEL: Any = None
_CHATTERBOX_EN: Any = None
_CHATTERBOX_MULTI: Any = None
_CHATTERBOX_VC: Any = None
_PROVIDER_SECRET = os.environ.pop("OSG_SPEECH_PROVIDER_SECRET", "")
_MODEL_ROOT_VALUE = os.environ.pop("OSG_SPEECH_MODEL_ROOT", "")
_MODEL_ROOT: Path | None = None


class WorkerFailure(Exception):
    def __init__(self, code: str, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


def _silence_process_output() -> None:
    """Keep third-party packages from corrupting protocol stdout or leaking inputs."""
    global _OUTPUT_SINK
    if _OUTPUT_SINK is not None:
        return
    sink = open(os.devnull, "w", encoding="utf-8")
    os.dup2(sink.fileno(), _ORIGINAL_STDOUT.fileno())
    os.dup2(sink.fileno(), _ORIGINAL_STDERR.fileno())
    sys.stdout = sink
    sys.stderr = sink
    _OUTPUT_SINK = sink


def _send(value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not payload or len(payload) > MAX_FRAME_BYTES:
        raise SystemExit(74)
    _PROTOCOL_OUT.write(struct.pack(">I", len(payload)))
    _PROTOCOL_OUT.write(payload)
    _PROTOCOL_OUT.flush()


def _receive() -> dict[str, Any] | None:
    length_bytes = sys.stdin.buffer.read(4)
    if not length_bytes:
        return None
    if len(length_bytes) != 4:
        raise SystemExit(74)
    length = struct.unpack(">I", length_bytes)[0]
    if length == 0 or length > MAX_FRAME_BYTES:
        raise SystemExit(74)
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise SystemExit(74)
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SystemExit(74) from None
    if not isinstance(decoded, dict):
        raise SystemExit(74)
    return decoded


def _request_id(request: dict[str, Any]) -> int:
    value = request.get("request_id")
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise WorkerFailure("invalid_request")
    if request.get("protocol") != PROTOCOL_VERSION:
        raise WorkerFailure("invalid_request")
    return value


def _emit_progress(request_id: int, phase: str, fraction: int) -> None:
    _send({
        "type": "progress",
        "protocol": PROTOCOL_VERSION,
        "request_id": request_id,
        "phase": phase,
        "fraction_millionths": fraction,
    })


def _emit_error(request_id: int, failure: WorkerFailure) -> None:
    _send({
        "type": "error",
        "protocol": PROTOCOL_VERSION,
        "request_id": request_id,
        "code": failure.code,
        "retryable": failure.retryable,
    })


def _require_keys(value: dict[str, Any], keys: set[str]) -> None:
    if set(value) != keys:
        raise WorkerFailure("invalid_request")


def _require_string(value: Any, *, maximum_bytes: int = 512, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise WorkerFailure("invalid_request")
    if len(value.encode("utf-8")) > maximum_bytes or any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise WorkerFailure("invalid_request")
    return value


def _require_identifier(value: Any, maximum: int = 160) -> str:
    value = _require_string(value, maximum_bytes=maximum)
    if not all(char.isascii() and (char.isalnum() or char in "-_.") for char in value):
        raise WorkerFailure("invalid_request")
    return value


def _require_language(value: Any) -> str:
    value = _require_string(value, maximum_bytes=35)
    if value.startswith("-") or value.endswith("-") or "--" in value:
        raise WorkerFailure("invalid_request")
    if not all(char.isascii() and (char.isalnum() or char == "-") for char in value):
        raise WorkerFailure("invalid_request")
    return value


def _require_number(value: Any, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise WorkerFailure("invalid_request")
    return value


def _require_keywords(callable_value: Any, names: set[str]) -> None:
    """Fail closed when an installed package no longer matches our pinned call contract."""
    try:
        parameters = inspect.signature(callable_value).parameters
    except (TypeError, ValueError):
        raise WorkerFailure("model_unavailable") from None
    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()):
        return
    if not names.issubset(parameters):
        raise WorkerFailure("model_unavailable")


def _require_path(value: Any, suffixes: set[str], *, must_exist: bool) -> Path:
    if not isinstance(value, str) or "\x00" in value:
        raise WorkerFailure("invalid_request")
    path = Path(value)
    suffix = path.suffix.lower().lstrip(".")
    if (not path.is_absolute()
            or (must_exist and suffix and suffix not in suffixes)
            or (not must_exist and suffix not in suffixes)):
        raise WorkerFailure("invalid_request")
    if must_exist and (not path.is_file() or path.stat().st_size <= 0):
        raise WorkerFailure("reference_rejected")
    if not must_exist and (path.exists() or path.is_symlink()):
        raise WorkerFailure("invalid_request")
    return path


def _audio_info(path: Path, maximum_seconds: int | None = None) -> tuple[int, int]:
    try:
        import soundfile as sf
        information = sf.info(str(path))
        sample_rate = int(information.samplerate)
        frames = int(information.frames)
    except (AttributeError, ImportError, OSError, RuntimeError, TypeError, ValueError):
        raise WorkerFailure("reference_rejected") from None
    if sample_rate <= 0 or frames <= 0:
        raise WorkerFailure("reference_rejected")
    if maximum_seconds is not None and frames > maximum_seconds * sample_rate:
        raise WorkerFailure("reference_rejected")
    return sample_rate, frames


def _load_audio_tensor(
    path: Path | str,
    *,
    frame_offset: int = 0,
    num_frames: int = -1,
) -> tuple[Any, int]:
    """Decode bounded audio without TorchCodec or a process-global FFmpeg install."""
    if (not isinstance(frame_offset, int) or isinstance(frame_offset, bool)
            or not isinstance(num_frames, int) or isinstance(num_frames, bool)
            or frame_offset < 0 or num_frames < -1):
        raise WorkerFailure("reference_rejected")
    try:
        import soundfile as sf
        import torch
        samples, sample_rate = sf.read(
            str(path),
            start=frame_offset,
            frames=num_frames,
            dtype="float32",
            always_2d=True,
        )
        waveform = torch.from_numpy(samples.T.copy())
    except (AttributeError, ImportError, OSError, RuntimeError, TypeError, ValueError):
        raise WorkerFailure("reference_rejected") from None
    if int(sample_rate) <= 0 or waveform.ndim != 2 or waveform.numel() == 0:
        raise WorkerFailure("reference_rejected")
    return waveform, int(sample_rate)


def _managed_torchaudio_load(
    path: Path | str,
    frame_offset: int = 0,
    num_frames: int = -1,
    normalize: bool = True,
    channels_first: bool = True,
    format: str | None = None,
    buffer_size: int = 4096,
    backend: str | None = None,
) -> tuple[Any, int]:
    """The closed subset of the legacy TorchAudio load contract used by F5."""
    if (normalize is not True or channels_first is not True or format is not None
            or buffer_size != 4096 or backend is not None):
        raise WorkerFailure("reference_rejected")
    return _load_audio_tensor(path, frame_offset=frame_offset, num_frames=num_frames)


def _require_audio_duration(path: Path, maximum_seconds: int) -> None:
    _audio_info(path, maximum_seconds)


def _reference_frame_range(
    sample_rate: int,
    total_frames: int,
    segment: tuple[int, int] | None,
) -> tuple[int, int]:
    if sample_rate <= 0 or total_frames <= 0:
        raise WorkerFailure("reference_rejected")
    if segment is None:
        if total_frames > 12 * sample_rate:
            raise WorkerFailure("reference_rejected")
        return 0, total_frames
    start, end = segment
    if start < 0 or start >= end or end - start > 12_000_000:
        raise WorkerFailure("invalid_request")
    start_frame = round(start * sample_rate / 1_000_000)
    end_frame = min(round(end * sample_rate / 1_000_000), total_frames)
    if start_frame >= end_frame:
        raise WorkerFailure("reference_rejected")
    return start_frame, end_frame - start_frame


def _settings(request: dict[str, Any], backend: str) -> dict[str, Any]:
    wrapper = request.get("settings")
    if not isinstance(wrapper, dict) or wrapper.get("backend") != backend or set(wrapper) != {"backend", "settings"}:
        raise WorkerFailure("invalid_request")
    value = wrapper.get("settings")
    if not isinstance(value, dict):
        raise WorkerFailure("invalid_request")
    return value


def _chatterbox_language(settings: dict[str, Any]) -> str:
    _require_keys(settings, {"language", "exaggeration_milli", "cfg_weight_milli"})
    language = _require_language(settings["language"]).lower()
    if language not in CHATTERBOX_LANGUAGES:
        raise WorkerFailure("invalid_request")
    return language


def _wav_metadata(path: Path) -> tuple[int, int, int]:
    try:
        with wave.open(str(path), "rb") as reader:
            channels = reader.getnchannels()
            rate = reader.getframerate()
            frames = reader.getnframes()
    except (wave.Error, OSError):
        raise WorkerFailure("encoding_failed") from None
    if channels <= 0 or rate <= 0 or frames <= 0:
        raise WorkerFailure("encoding_failed")
    duration = max(1, round(frames * 1_000_000 / rate))
    return duration, rate, channels


def _synchsafe(value: bytes) -> int:
    if len(value) != 4 or any(byte & 0x80 for byte in value):
        raise WorkerFailure("encoding_failed")
    return (value[0] << 21) | (value[1] << 14) | (value[2] << 7) | value[3]


def _mp3_metadata(path: Path) -> tuple[int, int, int]:
    try:
        data = path.read_bytes()
    except OSError:
        raise WorkerFailure("encoding_failed") from None
    if len(data) < 4 or len(data) > MAX_ARTIFACT_BYTES:
        raise WorkerFailure("encoding_failed")
    offset = 0
    if data.startswith(b"ID3"):
        if len(data) < 10:
            raise WorkerFailure("encoding_failed")
        offset = 10 + _synchsafe(data[6:10]) + (10 if data[5] & 0x10 else 0)
    bitrate_v1_l3 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
    bitrate_v2_l3 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
    sample_rates = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}
    total_samples = 0
    detected_rate: int | None = None
    channels = 0
    frames = 0
    cursor = offset
    while cursor + 4 <= len(data):
        header = int.from_bytes(data[cursor:cursor + 4], "big")
        if header >> 21 != 0x7FF:
            if frames == 0:
                cursor += 1
                continue
            break
        version = (header >> 19) & 0x3
        layer = (header >> 17) & 0x3
        bitrate_index = (header >> 12) & 0xF
        sample_index = (header >> 10) & 0x3
        padding = (header >> 9) & 0x1
        if version == 1 or layer != 1 or sample_index == 3:
            if frames == 0:
                cursor += 1
                continue
            break
        rate = sample_rates[version][sample_index]
        bitrate = (bitrate_v1_l3 if version == 3 else bitrate_v2_l3)[bitrate_index] * 1000
        if bitrate == 0:
            raise WorkerFailure("encoding_failed")
        samples = 1152 if version == 3 else 576
        frame_length = (144 * bitrate // rate + padding) if version == 3 else (72 * bitrate // rate + padding)
        if frame_length < 4 or cursor + frame_length > len(data):
            break
        if detected_rate is None:
            detected_rate = rate
            channels = 1 if ((header >> 6) & 0x3) == 3 else 2
        elif detected_rate != rate:
            raise WorkerFailure("encoding_failed")
        total_samples += samples
        frames += 1
        cursor += frame_length
    if frames == 0 or detected_rate is None or channels == 0:
        raise WorkerFailure("encoding_failed")
    return max(1, round(total_samples * 1_000_000 / detected_rate)), detected_rate, channels


def _artifact(path: Path, output_format: str) -> dict[str, int]:
    try:
        size = path.stat().st_size
    except OSError:
        raise WorkerFailure("encoding_failed") from None
    if not path.is_file() or size <= 0 or size > MAX_ARTIFACT_BYTES:
        raise WorkerFailure("encoding_failed")
    if output_format == "wav":
        duration, rate, channels = _wav_metadata(path)
    elif output_format == "mp3":
        duration, rate, channels = _mp3_metadata(path)
    else:
        raise WorkerFailure("invalid_request")
    return {"bytes": size, "duration_micros": duration, "sample_rate_hz": rate, "channels": channels}


def _device() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except (ImportError, RuntimeError):
        pass
    return "cpu"


def _managed_model_root() -> Path | None:
    global _MODEL_ROOT
    if not _MODEL_ROOT_VALUE:
        return None
    if _MODEL_ROOT is not None:
        return _MODEL_ROOT
    try:
        candidate = Path(_MODEL_ROOT_VALUE)
        if not candidate.is_absolute():
            raise OSError
        candidate = candidate.resolve(strict=True)
        if not candidate.is_dir():
            raise OSError
    except (OSError, RuntimeError):
        raise WorkerFailure("model_unavailable") from None
    _MODEL_ROOT = candidate
    return candidate


def _managed_model_file(root: Path, relative: str) -> Path:
    try:
        candidate = (root / relative).resolve(strict=True)
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise OSError
    except (OSError, RuntimeError):
        raise WorkerFailure("model_unavailable") from None
    return candidate


def _managed_model_directory(root: Path, relative: str, required_files: tuple[str, ...]) -> Path:
    try:
        candidate = (root / relative).resolve(strict=True)
        if not candidate.is_relative_to(root) or not candidate.is_dir():
            raise OSError
    except (OSError, RuntimeError):
        raise WorkerFailure("model_unavailable") from None
    for filename in required_files:
        _managed_model_file(candidate, filename)
    return candidate


def _load_f5() -> Any:
    global _F5_MODEL
    if _F5_MODEL is None:
        try:
            from f5_tts.api import F5TTS
            _require_keywords(F5TTS, {
                "device", "ckpt_file", "vocab_file", "vocoder_local_path",
            })
            _require_keywords(F5TTS.infer, {
                "ref_file", "ref_text", "gen_text", "file_wave", "remove_silence",
                "speed", "nfe_step", "sway_sampling_coef", "cfg_strength", "seed",
            })
            model_root = _managed_model_root()
            if model_root is None:
                _F5_MODEL = F5TTS(device=_device())
            else:
                checkpoint = _managed_model_file(
                    model_root, "F5TTS_v1_Base/model_1250000.safetensors",
                )
                vocabulary = _managed_model_file(model_root, "F5TTS_v1_Base/vocab.txt")
                vocoder = _managed_model_directory(
                    model_root, "vocos", ("config.yaml", "pytorch_model.bin"),
                )
                _F5_MODEL = F5TTS(
                    ckpt_file=str(checkpoint),
                    vocab_file=str(vocabulary),
                    vocoder_local_path=str(vocoder),
                    device=_device(),
                )
        except ImportError:
            raise WorkerFailure("model_unavailable") from None
        except Exception:
            raise WorkerFailure("model_unavailable") from None
    return _F5_MODEL


def _load_chatterbox(multilingual: bool) -> Any:
    global _CHATTERBOX_EN, _CHATTERBOX_MULTI
    try:
        if multilingual:
            if _CHATTERBOX_MULTI is None:
                try:
                    from chatterbox import ChatterboxMultilingualTTS
                except ImportError:
                    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
                _require_keywords(ChatterboxMultilingualTTS.from_local, {"ckpt_dir", "device"})
                _require_keywords(ChatterboxMultilingualTTS.generate, {
                    "text", "language_id", "audio_prompt_path", "exaggeration",
                    "cfg_weight", "temperature",
                })
                model_root = _managed_model_root()
                _CHATTERBOX_MULTI = (
                    ChatterboxMultilingualTTS.from_pretrained(_device())
                    if model_root is None
                    else _load_local_chatterbox(
                        ChatterboxMultilingualTTS, model_root, _device(), multilingual=True,
                    )
                )
            return _CHATTERBOX_MULTI
        if _CHATTERBOX_EN is None:
            try:
                from chatterbox import ChatterboxTTS
            except ImportError:
                from chatterbox.tts import ChatterboxTTS
            _require_keywords(ChatterboxTTS.from_local, {"ckpt_dir", "device"})
            _require_keywords(ChatterboxTTS.generate, {
                "text", "audio_prompt_path", "exaggeration", "cfg_weight", "temperature",
            })
            model_root = _managed_model_root()
            _CHATTERBOX_EN = (
                ChatterboxTTS.from_pretrained(_device())
                if model_root is None
                else ChatterboxTTS.from_local(model_root, _device())
            )
        return _CHATTERBOX_EN
    except ImportError:
        raise WorkerFailure("model_unavailable") from None
    except Exception:
        raise WorkerFailure("model_unavailable") from None


def _load_local_chatterbox(
    model_class: Any,
    model_root: Path,
    device: str,
    *,
    multilingual: bool,
) -> Any:
    if not multilingual:
        return model_class.from_local(model_root, device)
    # chatterbox-tts 0.1.7's multilingual tokenizer calls hf_hub_download
    # even when from_local() is used. Replace that single lookup while the
    # constructor runs so Cangjie5_TC.json is resolved from the verified
    # package and a missing network can never silently disable Chinese text.
    try:
        from chatterbox.models.tokenizers import tokenizer as tokenizer_module
    except ImportError:
        raise WorkerFailure("model_unavailable") from None
    expected = _managed_model_file(model_root, "Cangjie5_TC.json")
    original = tokenizer_module.hf_hub_download

    def local_cangjie(*, repo_id: str, filename: str, **_: Any) -> str:
        if repo_id != "ResembleAI/chatterbox" or filename != "Cangjie5_TC.json":
            raise WorkerFailure("model_unavailable")
        return str(expected)

    tokenizer_module.hf_hub_download = local_cangjie
    try:
        return model_class.from_local(model_root, device)
    finally:
        tokenizer_module.hf_hub_download = original


class _WeightsOnlyTorchProxy:
    """Expose Torch while constraining one reviewed conditioning-tensor load."""

    def __init__(
        self,
        torch_module: Any,
        safe_load: Any,
        expected_path: Path,
        verified_input: BinaryIO,
        device: str,
    ) -> None:
        self._torch = torch_module
        self._safe_load = safe_load
        self._expected_path = expected_path
        self._verified_input = verified_input
        self._device = device
        self.load_count = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._torch, name)

    def load(self, source: Any, *args: Any, **kwargs: Any) -> Any:
        if (
            self.load_count != 0
            or args
            or not set(kwargs).issubset({"map_location", "weights_only"})
            or kwargs.get("weights_only", True) is not True
        ):
            raise WorkerFailure("model_unavailable")
        try:
            candidate = Path(source).resolve(strict=True)
        except (OSError, RuntimeError, TypeError):
            raise WorkerFailure("model_unavailable") from None
        if candidate != self._expected_path:
            raise WorkerFailure("model_unavailable")
        self.load_count = 1
        return self._safe_load(
            self._verified_input,
            map_location="cpu" if self._device in {"cpu", "mps"} else None,
            weights_only=True,
        )


def _guarded_chatterbox_vc_from_local(
    model_class: Any,
    model_root: Path,
    device: str,
) -> Any:
    """Run the pinned VC loader only through a tensor-only Torch boundary."""
    if device not in {"cpu", "mps", "cuda"}:
        raise WorkerFailure("model_unavailable")
    conditionals = _managed_model_file(model_root, "conds.pt")
    loader = model_class.from_local
    function = getattr(loader, "__func__", loader)
    code = getattr(function, "__code__", None)
    globals_map = getattr(function, "__globals__", None)
    if (
        code is None
        or not isinstance(globals_map, dict)
        or getattr(function, "__closure__", None)
        or getattr(function, "__defaults__", None)
        or getattr(function, "__kwdefaults__", None)
    ):
        raise WorkerFailure("model_unavailable")

    try:
        instructions = list(dis.get_instructions(function))
    except (TypeError, ValueError):
        raise WorkerFailure("model_unavailable") from None
    if any(instruction.opname in {
        "IMPORT_NAME", "IMPORT_FROM", "IMPORT_STAR",
        "STORE_GLOBAL", "DELETE_GLOBAL",
        "STORE_ATTR", "DELETE_ATTR", "STORE_SUBSCR", "DELETE_SUBSCR",
        "MAKE_FUNCTION",
    } for instruction in instructions):
        raise WorkerFailure("model_unavailable")
    allowed_globals = {"Path", "S3Gen", "load_file", "torch"}
    loaded_globals = {
        instruction.argval for instruction in instructions
        if instruction.opname in {"LOAD_GLOBAL", "LOAD_NAME"}
    }
    if not loaded_globals.issubset(allowed_globals):
        raise WorkerFailure("model_unavailable")
    if globals_map.get("Path") is not Path:
        raise WorkerFailure("model_unavailable")
    load_sites = [
        index for index, instruction in enumerate(instructions)
        if instruction.opname in {"LOAD_ATTR", "LOAD_METHOD"}
        and instruction.argval == "load"
    ]
    if len(load_sites) != 1:
        raise WorkerFailure("model_unavailable")
    load_index = load_sites[0]
    if load_index == 0:
        raise WorkerFailure("model_unavailable")
    load_owner = instructions[load_index - 1]
    if load_owner.opname != "LOAD_GLOBAL" or load_owner.argval != "torch":
        raise WorkerFailure("model_unavailable")

    torch_module = globals_map.get("torch")
    torch_load = getattr(torch_module, "load", None)
    if not callable(torch_load):
        raise WorkerFailure("model_unavailable")
    try:
        weights_only = inspect.signature(torch_load).parameters.get("weights_only")
    except (TypeError, ValueError):
        raise WorkerFailure("model_unavailable") from None
    if weights_only is None or weights_only.kind == inspect.Parameter.POSITIONAL_ONLY:
        raise WorkerFailure("model_unavailable")

    try:
        with conditionals.open("rb") as source:
            payload = source.read(CHATTERBOX_CONDITIONALS_BYTES + 1)
    except OSError:
        raise WorkerFailure("model_unavailable") from None
    if (
        len(payload) != CHATTERBOX_CONDITIONALS_BYTES
        or hashlib.sha256(payload).hexdigest() != CHATTERBOX_CONDITIONALS_SHA256
    ):
        raise WorkerFailure("model_unavailable")

    with io.BytesIO(payload) as verified_input:
        proxy = _WeightsOnlyTorchProxy(
            torch_module,
            torch_load,
            conditionals,
            verified_input,
            device,
        )
        globals_map["torch"] = proxy
        try:
            model = loader(model_root, device)
        finally:
            globals_map["torch"] = torch_module
    if proxy.load_count != 1:
        raise WorkerFailure("model_unavailable")
    return model


def _load_chatterbox_vc() -> Any:
    global _CHATTERBOX_VC
    if _CHATTERBOX_VC is None:
        try:
            from chatterbox.vc import ChatterboxVC
            _require_keywords(ChatterboxVC.from_local, {"ckpt_dir", "device"})
            _require_keywords(ChatterboxVC.generate, {"audio", "target_voice_path"})
            model_root = _managed_model_root()
            if model_root is None:
                raise WorkerFailure("model_unavailable")
            _CHATTERBOX_VC = _guarded_chatterbox_vc_from_local(
                ChatterboxVC,
                model_root,
                _device(),
            )
        except ImportError:
            raise WorkerFailure("model_unavailable") from None
        except Exception:
            raise WorkerFailure("model_unavailable") from None
    return _CHATTERBOX_VC


def _save_tensor_wav(path: Path, waveform: Any, sample_rate: int) -> None:
    try:
        import soundfile as sf
        samples = waveform.detach().cpu().float()
        if samples.ndim == 1:
            samples = samples.unsqueeze(0)
        if samples.ndim != 2 or samples.numel() == 0:
            raise WorkerFailure("encoding_failed")
        sf.write(str(path), samples.transpose(0, 1).numpy(), sample_rate, format="WAV")
    except ImportError:
        raise WorkerFailure("model_unavailable") from None
    except WorkerFailure:
        raise
    except Exception:
        raise WorkerFailure("encoding_failed") from None


def _prepare_reference(request_id: int, request: dict[str, Any], backend: str) -> None:
    _require_keys(request, {"protocol", "request_id", "command", "backend", "input_path", "filters", "output_path", "output_format"})
    if request["command"] != "prepare_reference" or backend != "f5_tts" or request["backend"] != backend or request["output_format"] != "wav":
        raise WorkerFailure("invalid_request")
    source = _require_path(request["input_path"], {"wav", "wave", "mp3", "m4a", "mp4"}, must_exist=True)
    output = _require_path(request["output_path"], {"wav"}, must_exist=False)
    filters = request["filters"]
    if not isinstance(filters, list):
        raise WorkerFailure("invalid_request")
    cursor = 0
    segment: tuple[int, int] | None = None
    if len(filters) >= 2 and isinstance(filters[0], dict) and filters[0].get("operation") == "trim":
        trim = filters[0]
        _require_keys(trim, {"operation", "start", "end"})
        start = _require_number(trim["start"], 0, 7 * 24 * 60 * 60 * 1_000_000)
        end = _require_number(trim["end"], 1, 7 * 24 * 60 * 60 * 1_000_000)
        if (start >= end
                or end - start > 12_000_000
                or filters[1] != {"operation": "reset_timestamps"}):
            raise WorkerFailure("invalid_request")
        segment = (start, end)
        cursor = 2
    expected_tail = [
        {"operation": "resample", "sample_rate": 44_100, "channels": 2},
        {"operation": "append_silence", "duration": 1_000_000},
    ]
    if filters[cursor:] != expected_tail:
        raise WorkerFailure("invalid_request")
    _emit_progress(request_id, "loading_model", 0)
    try:
        import torch
        import torchaudio as ta
    except ImportError:
        raise WorkerFailure("model_unavailable") from None
    _emit_progress(request_id, "loading_model", 1_000_000)
    _emit_progress(request_id, "encoding", 0)
    try:
        sample_rate, total_frames = _audio_info(source)
        frame_offset, num_frames = _reference_frame_range(sample_rate, total_frames, segment)
        waveform, loaded_rate = _load_audio_tensor(
            source,
            frame_offset=frame_offset,
            num_frames=num_frames,
        )
        if int(loaded_rate) != sample_rate:
            raise WorkerFailure("reference_rejected")
        if waveform.numel() == 0:
            raise WorkerFailure("reference_rejected")
        if sample_rate != 44_100:
            waveform = ta.functional.resample(waveform, sample_rate, 44_100)
        if waveform.shape[0] == 1:
            waveform = waveform.repeat(2, 1)
        elif waveform.shape[0] > 2:
            waveform = waveform[:2, :]
        silence = torch.zeros((2, 44_100), dtype=waveform.dtype, device=waveform.device)
        waveform = torch.cat((waveform, silence), dim=1)
        _save_tensor_wav(output, waveform, 44_100)
    except WorkerFailure:
        raise
    except Exception:
        raise WorkerFailure("reference_rejected") from None
    metadata = _artifact(output, "wav")
    _emit_progress(request_id, "encoding", 1_000_000)
    _send({"type": "complete", "protocol": PROTOCOL_VERSION, "request_id": request_id, "artifact": metadata})


def _synthesize_f5(text: str, settings: dict[str, Any], reference: Path, output: Path) -> None:
    _require_keys(settings, {"reference_text", "model", "speech_rate_milli", "nfe_steps", "sway_milli", "guidance_milli", "seed", "remove_silence"})
    reference_text = settings["reference_text"]
    if reference_text is not None:
        reference_text = _require_string(reference_text, maximum_bytes=MAX_TEXT_BYTES)
    elif _managed_model_root() is not None:
        # The upstream fallback downloads Whisper weights implicitly. Managed
        # release workers are offline and must receive host-transcribed text.
        raise WorkerFailure("model_unavailable")
    model = settings["model"]
    if model not in (None, "f5tts-v1-base", "F5TTS_v1_Base"):
        raise WorkerFailure("model_unavailable")
    rate = _require_number(settings["speech_rate_milli"], 500, 2000) / 1000.0
    steps = _require_number(settings["nfe_steps"], 8, 64)
    if steps not in (8, 16, 32, 64):
        raise WorkerFailure("invalid_request")
    sway = _require_number(settings["sway_milli"], -1100, 1700) / 1000.0
    guidance = _require_number(settings["guidance_milli"], 1000, 5000) / 1000.0
    seed = settings["seed"]
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 or seed > 2**64 - 1):
        raise WorkerFailure("invalid_request")
    if not isinstance(settings["remove_silence"], bool):
        raise WorkerFailure("invalid_request")
    _require_audio_duration(reference, 13)
    instance = _load_f5()
    try:
        import torchaudio
        original_load = torchaudio.load
        torchaudio.load = _managed_torchaudio_load
        try:
            instance.infer(
                ref_file=str(reference),
                ref_text=reference_text or "",
                gen_text=text,
                file_wave=str(output),
                remove_silence=settings["remove_silence"],
                speed=rate,
                nfe_step=steps,
                sway_sampling_coef=sway,
                cfg_strength=guidance,
                seed=seed,
            )
        finally:
            torchaudio.load = original_load
    except Exception:
        raise WorkerFailure("synthesis_failed") from None


def _synthesize_chatterbox(text: str, settings: dict[str, Any], reference: Path, output: Path) -> None:
    language = _chatterbox_language(settings)
    exaggeration = _require_number(settings["exaggeration_milli"], 250, 2000) / 1000.0
    cfg_weight = _require_number(settings["cfg_weight_milli"], 0, 1000) / 1000.0
    _require_audio_duration(reference, 60)
    multilingual = language != "en"
    model = _load_chatterbox(multilingual)
    arguments: dict[str, Any] = {
        "text": text,
        "audio_prompt_path": str(reference),
        "exaggeration": exaggeration,
        "cfg_weight": cfg_weight,
        "temperature": 0.8,
    }
    if multilingual:
        arguments["language_id"] = language
    try:
        waveform = model.generate(**arguments)
    except Exception:
        raise WorkerFailure("synthesis_failed") from None
    _save_tensor_wav(output, waveform, int(model.sr))


async def _synthesize_edge_async(text: str, settings: dict[str, Any], output: Path) -> None:
    _require_keys(settings, {"voice", "rate_percent", "volume_percent", "pitch_hz"})
    voice = _require_identifier(settings["voice"], 128)
    rate = _require_number(settings["rate_percent"], -100, 100)
    volume = _require_number(settings["volume_percent"], -100, 100)
    pitch = _require_number(settings["pitch_hz"], -100, 100)
    try:
        import edge_tts
        _require_keywords(edge_tts.Communicate, {"text", "voice", "rate", "volume", "pitch"})
        communicate = edge_tts.Communicate(
            text,
            voice,
            rate=f"{rate:+d}%",
            volume=f"{volume:+d}%",
            pitch=f"{pitch:+d}Hz",
        )
        await communicate.save(str(output))
    except ImportError:
        raise WorkerFailure("model_unavailable") from None
    except Exception:
        raise WorkerFailure("provider_unavailable", retryable=True) from None


def _synthesize_edge(text: str, settings: dict[str, Any], output: Path) -> None:
    asyncio.run(_synthesize_edge_async(text, settings, output))


def _synthesize_gtts(text: str, settings: dict[str, Any], output: Path) -> None:
    _require_keys(settings, {"language", "domain", "slow"})
    language = _require_language(settings["language"])
    domain = _require_string(settings["domain"], maximum_bytes=16)
    if domain not in {"com", "com.au", "co.uk", "us", "ca", "co.in", "ie", "co.za", "com.br", "pt", "es", "com.mx", "fr"}:
        raise WorkerFailure("invalid_request")
    if not isinstance(settings["slow"], bool):
        raise WorkerFailure("invalid_request")
    try:
        from gtts import gTTS
        _require_keywords(gTTS, {"text", "lang", "tld", "slow"})
        gTTS(text=text, lang=language, tld=domain, slow=settings["slow"]).save(str(output))
    except ImportError:
        raise WorkerFailure("model_unavailable") from None
    except Exception:
        raise WorkerFailure("provider_unavailable", retryable=True) from None


def _decode_pcm_inline(inline: Any) -> bytes | None:
    if inline is None:
        return None
    data = getattr(inline, "data", None)
    if data is None:
        return None
    if getattr(inline, "mime_type", None) != "audio/pcm;rate=24000":
        raise WorkerFailure("encoding_failed")
    if isinstance(data, str):
        try:
            data = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            raise WorkerFailure("encoding_failed") from None
    if not isinstance(data, (bytes, bytearray)):
        raise WorkerFailure("encoding_failed")
    return bytes(data)


async def _synthesize_gemini_async(text: str, settings: dict[str, Any], output: Path) -> None:
    _require_keys(settings, {"model", "voice", "language"})
    model = _require_string(settings["model"], maximum_bytes=160)
    voice = _require_identifier(settings["voice"], 128)
    language = _require_language(settings["language"])
    if model not in GEMINI_MODELS or voice not in GEMINI_VOICES:
        raise WorkerFailure("model_unavailable")
    secret = _PROVIDER_SECRET
    if not secret or len(secret) > 4096:
        raise WorkerFailure("authentication_failed")
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        raise WorkerFailure("provider_unavailable") from None
    config = {
        "response_modalities": ["AUDIO"],
        "speech_config": {
            "voice_config": {"prebuilt_voice_config": {"voice_name": voice}},
            "language_code": language,
        },
        "system_instruction": "Read the supplied text exactly. Do not add, omit, translate, or explain words.",
    }
    pcm = bytearray()
    turn_completed = False
    try:
        client = genai.Client(api_key=secret)
        async with client.aio.live.connect(model=model, config=config) as session:
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text=text)]),
                turn_complete=True,
            )
            async for response in session.receive():
                content = getattr(response, "server_content", None)
                if content is not None and getattr(content, "interrupted", False):
                    raise WorkerFailure("provider_unavailable", retryable=True)
                turn = getattr(content, "model_turn", None) if content is not None else None
                for part in getattr(turn, "parts", ()) if turn is not None else ():
                    inline = getattr(part, "inline_data", None)
                    data = _decode_pcm_inline(inline)
                    if data is not None:
                        if len(pcm) + len(data) > MAX_ARTIFACT_BYTES - 44:
                            raise WorkerFailure("encoding_failed")
                        pcm.extend(data)
                if content is not None and getattr(content, "turn_complete", False):
                    turn_completed = True
                    break
    except WorkerFailure:
        raise
    except Exception as error:
        status = getattr(error, "status_code", None) or getattr(error, "code", None)
        if status in (401, 403, "UNAUTHENTICATED", "PERMISSION_DENIED"):
            raise WorkerFailure("authentication_failed") from None
        if status in (429, "RESOURCE_EXHAUSTED"):
            raise WorkerFailure("provider_rate_limited", retryable=True) from None
        raise WorkerFailure("provider_unavailable", retryable=True) from None
    finally:
        secret = ""
    if not turn_completed:
        raise WorkerFailure("provider_unavailable", retryable=True)
    if not pcm or len(pcm) % 2:
        raise WorkerFailure("encoding_failed")
    try:
        with wave.open(str(output), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(24000)
            writer.writeframes(pcm)
    except (OSError, wave.Error):
        raise WorkerFailure("encoding_failed") from None


def _synthesize_gemini(text: str, settings: dict[str, Any], output: Path) -> None:
    asyncio.run(_synthesize_gemini_async(text, settings, output))


def _synthesize(request_id: int, request: dict[str, Any], backend: str) -> None:
    _require_keys(request, {"protocol", "request_id", "command", "backend", "segment_id", "text", "settings", "reference_path", "output_path", "output_format"})
    if request["command"] != "synthesize" or request["backend"] != backend:
        raise WorkerFailure("invalid_request")
    _require_identifier(request["segment_id"], 96)
    text = _require_string(request["text"], maximum_bytes=MAX_TEXT_BYTES)
    output_format = request["output_format"]
    if output_format != FORMATS[backend]:
        raise WorkerFailure("invalid_request")
    output = _require_path(request["output_path"], {output_format}, must_exist=False)
    reference_value = request["reference_path"]
    reference = None
    if backend in {"f5_tts", "chatterbox"}:
        reference = _require_path(reference_value, {"wav", "wave", "mp3", "m4a", "mp4"}, must_exist=True)
    elif reference_value is not None:
        raise WorkerFailure("invalid_request")
    settings = _settings(request, backend)
    _emit_progress(request_id, "loading_model", 0)
    if backend == "f5_tts":
        _load_f5()
    elif backend == "chatterbox":
        language = _chatterbox_language(settings)
        _load_chatterbox(language != "en")
    _emit_progress(request_id, "loading_model", 1_000_000)
    _emit_progress(request_id, "synthesizing", 0)
    if backend == "f5_tts":
        _synthesize_f5(text, settings, reference, output)
    elif backend == "chatterbox":
        _synthesize_chatterbox(text, settings, reference, output)
    elif backend == "edge_tts":
        _synthesize_edge(text, settings, output)
    elif backend == "gtts":
        _synthesize_gtts(text, settings, output)
    elif backend == "gemini_live":
        _synthesize_gemini(text, settings, output)
    else:
        raise WorkerFailure("invalid_request")
    _emit_progress(request_id, "synthesizing", 1_000_000)
    _emit_progress(request_id, "encoding", 0)
    metadata = _artifact(output, output_format)
    _emit_progress(request_id, "encoding", 1_000_000)
    _send({"type": "complete", "protocol": PROTOCOL_VERSION, "request_id": request_id, "artifact": metadata})


def _convert_voice(request_id: int, request: dict[str, Any], backend: str) -> None:
    _require_keys(request, {"protocol", "request_id", "command", "backend", "input_path", "target_voice_path", "output_path", "output_format"})
    if request["command"] != "convert_voice" or backend != "chatterbox" or request["backend"] != backend or request["output_format"] != "wav":
        raise WorkerFailure("invalid_request")
    source = _require_path(request["input_path"], {"wav", "wave", "mp3", "m4a", "mp4"}, must_exist=True)
    target = _require_path(request["target_voice_path"], {"wav", "wave", "mp3", "m4a", "mp4"}, must_exist=True)
    output = _require_path(request["output_path"], {"wav"}, must_exist=False)
    _emit_progress(request_id, "loading_model", 0)
    _require_audio_duration(source, 60 * 60)
    _require_audio_duration(target, 60)
    model = _load_chatterbox_vc()
    _emit_progress(request_id, "loading_model", 1_000_000)
    _emit_progress(request_id, "synthesizing", 0)
    try:
        waveform = model.generate(audio=str(source), target_voice_path=str(target))
    except Exception:
        raise WorkerFailure("synthesis_failed") from None
    _emit_progress(request_id, "synthesizing", 1_000_000)
    _emit_progress(request_id, "encoding", 0)
    _save_tensor_wav(output, waveform, int(model.sr))
    metadata = _artifact(output, "wav")
    _emit_progress(request_id, "encoding", 1_000_000)
    _send({"type": "complete", "protocol": PROTOCOL_VERSION, "request_id": request_id, "artifact": metadata})


def _voices_for(backend: str) -> list[dict[str, str]]:
    if backend == "edge_tts":
        try:
            import edge_tts
            values = asyncio.run(edge_tts.list_voices())
        except ImportError:
            raise WorkerFailure("model_unavailable") from None
        except Exception:
            raise WorkerFailure("provider_unavailable", retryable=True) from None
        voices = []
        for value in values:
            identifier = value.get("ShortName")
            language = value.get("Locale")
            display = value.get("FriendlyName") or value.get("LocalName") or identifier
            gender = str(value.get("Gender", "unknown")).lower()
            if gender not in {"female", "male", "neutral"}:
                gender = "unknown"
            voices.append({"id": identifier, "display_name": display, "language": language, "gender": gender})
        return voices
    if backend == "gtts":
        try:
            from gtts.lang import tts_langs
            return [
                {"id": language, "display_name": name, "language": language, "gender": "unknown"}
                for language, name in sorted(tts_langs().items())
            ]
        except ImportError:
            raise WorkerFailure("model_unavailable") from None
        except Exception:
            raise WorkerFailure("provider_unavailable", retryable=True) from None
    if backend == "f5_tts":
        try:
            from f5_tts.api import F5TTS  # noqa: F401
            import torch  # noqa: F401
            import torchaudio  # noqa: F401
        except ImportError:
            raise WorkerFailure("model_unavailable") from None
        except Exception:
            raise WorkerFailure("model_unavailable") from None
        return []
    if backend == "chatterbox":
        try:
            try:
                from chatterbox import ChatterboxTTS  # noqa: F401
            except ImportError:
                from chatterbox.tts import ChatterboxTTS  # noqa: F401
            from chatterbox.vc import ChatterboxVC  # noqa: F401
            import torch  # noqa: F401
            import torchaudio  # noqa: F401
        except ImportError:
            raise WorkerFailure("model_unavailable") from None
        except Exception:
            raise WorkerFailure("model_unavailable") from None
        return []
    if backend == "gemini_live":
        try:
            from google import genai  # noqa: F401
        except ImportError:
            raise WorkerFailure("provider_unavailable") from None
        return [
            {
                "id": voice,
                "display_name": voice,
                "language": "mul",
                "gender": GEMINI_VOICE_GENDERS[voice],
            }
            for voice in GEMINI_VOICES
        ]
    raise WorkerFailure("invalid_request")


def _list_voices(request_id: int, request: dict[str, Any], backend: str) -> None:
    _require_keys(request, {"protocol", "request_id", "command", "backend"})
    if request["command"] != "list_voices" or request["backend"] != backend:
        raise WorkerFailure("invalid_request")
    _emit_progress(request_id, "loading_model", 0)
    voices = _voices_for(backend)
    _emit_progress(request_id, "loading_model", 1_000_000)
    _send({"type": "voices", "protocol": PROTOCOL_VERSION, "request_id": request_id, "voices": voices})


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--stdio-worker", action="store_true")
    parser.add_argument("--protocol-version", type=int)
    parser.add_argument("--backend", choices=sorted(BACKENDS))
    arguments, extras = parser.parse_known_args()
    if extras or not arguments.stdio_worker or arguments.protocol_version != PROTOCOL_VERSION or arguments.backend is None:
        raise SystemExit(64)
    return arguments


def main() -> None:
    arguments = _parse_args()
    backend: str = arguments.backend
    _send({
        "type": "hello",
        "protocol": PROTOCOL_VERSION,
        "backend": backend,
        "worker_version": WORKER_VERSION,
        "max_text_bytes": MAX_TEXT_BYTES,
    })
    _silence_process_output()
    while True:
        request = _receive()
        if request is None:
            return
        request_id = 0
        try:
            request_id = _request_id(request)
            command = request.get("command")
            if command == "shutdown":
                _require_keys(request, {"protocol", "request_id", "command"})
                return
            if command == "synthesize":
                _synthesize(request_id, request, backend)
            elif command == "convert_voice":
                _convert_voice(request_id, request, backend)
            elif command == "prepare_reference":
                _prepare_reference(request_id, request, backend)
            elif command == "list_voices":
                _list_voices(request_id, request, backend)
            else:
                raise WorkerFailure("invalid_request")
        except WorkerFailure as failure:
            if request_id <= 0:
                raise SystemExit(74) from None
            _emit_error(request_id, failure)
        except Exception:
            if request_id <= 0:
                raise SystemExit(70) from None
            _emit_error(request_id, WorkerFailure("synthesis_failed"))


if __name__ == "__main__":
    main()
