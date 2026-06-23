"""
Faster-Whisper ASR FastAPI service (OSG on-demand GPU engine).

Mirrors parakeet_wrapper/app.py's contract so the frontend adapter/proxy are reused verbatim:
  GET  /health              -> 503 until the model is loaded, 200 after
  POST /transcribe          -> multipart audio file
  POST /transcribe_base64   -> { audio_base64, filename, segment_strategy, max_chars, max_words, pause_threshold }
Response: { transcription, segments: [{start, end, segment}], srt_content, duration_seconds }

Differences from Parakeet: faster-whisper (CTranslate2) yields REAL per-word start/end timestamps, so the
segmentation here uses true word ends (no estimation). Model + runtime come from env (set by engineSpawn):
  ASR_MODEL_DIR  - the CTranslate2 model directory pulled from ModelScope at install time
  FW_TURBO_PORT  - the port to bind (default 3039)
GPU is preferred (float16 on CUDA) with a CPU fallback (int8), per the project's GPU-first-but-not-only policy.
"""

import os
import gc
import math
import base64
import logging
import datetime
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, Literal, List

import uvicorn

# --- CUDA DLL bootstrap (must run before CTranslate2/faster-whisper builds a session) ---
# torch (2.x+cuXXX) bundles the CUDA 12 / cuDNN 9 DLLs that CTranslate2 needs (cublas*, cudnn*) under
# site-packages/torch/lib, but that dir is not on the Windows DLL search path unless we add it. Import
# torch first and register its lib dir so CTranslate2 can load the GPU runtime instead of silently
# falling back to CPU (mirrors the onnxruntime.preload_dlls() trick the Parakeet service uses).
_CUDA_OK = False
try:
    import torch  # noqa: F401
    _CUDA_OK = bool(torch.cuda.is_available())
    _torch_lib = os.path.join(os.path.dirname(torch.__file__), "lib")
    if os.path.isdir(_torch_lib):
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(_torch_lib)
            except Exception:
                pass
        os.environ["PATH"] = _torch_lib + os.pathsep + os.environ.get("PATH", "")
except Exception as _e:  # torch should be installed, but never crash the service over the bootstrap
    logging.getLogger(__name__).debug(f"torch CUDA bootstrap skipped: {_e}")


# --- Prefer the bundled ffmpeg/ffprobe over any system install (matches the Parakeet service) ---
def _prepend_bundled_ffmpeg_to_path():
    import glob
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    for pattern in (
        os.path.join(root, "node_modules", "@remotion", "compositor-*", exe),
        os.path.join(root, "node_modules", "@ffmpeg-installer", "*", exe),
    ):
        for candidate in glob.glob(pattern):
            if os.path.isfile(candidate):
                os.environ["PATH"] = os.path.dirname(candidate) + os.pathsep + os.environ.get("PATH", "")
                return os.path.dirname(candidate)
    return None


_prepend_bundled_ffmpeg_to_path()

from faster_whisper import WhisperModel
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

MODEL_DIR = os.getenv("ASR_MODEL_DIR", "")
PORT = int(os.getenv("FW_TURBO_PORT", "3039"))
app_state = {}


# --- FastAPI lifespan: load the model once ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    device = "cuda" if _CUDA_OK else "cpu"
    compute_type = "float16" if _CUDA_OK else "int8"
    model_ref = MODEL_DIR if MODEL_DIR and os.path.isdir(MODEL_DIR) else "large-v3"
    logger.info(f"Loading faster-whisper model from '{model_ref}' on {device} ({compute_type})...")
    try:
        app_state["model"] = WhisperModel(model_ref, device=device, compute_type=compute_type)
        app_state["device"] = device
        logger.info(f"faster-whisper model loaded on {device}.")
    except Exception as e:
        logger.error(f"Failed to load faster-whisper model: {e}", exc_info=True)
        app_state["model"] = None

    yield

    logger.info("Cleaning up resources...")
    app_state.clear()
    gc.collect()


app = FastAPI(title="Faster-Whisper Transcription API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)


# --- SRT / segmentation helpers (port of parakeet_wrapper/app.py, real word ends) ---
def format_srt_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    delta = datetime.timedelta(seconds=seconds)
    hours, remainder = divmod(int(delta.total_seconds()), 3600)
    minutes, secs = divmod(remainder, 60)
    milliseconds = delta.microseconds // 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def generate_srt_content(segment_timestamps: list) -> str:
    lines = []
    for i, ts in enumerate(segment_timestamps):
        lines.append(str(i + 1))
        lines.append(f"{format_srt_time(ts['start'])} --> {format_srt_time(ts['end'])}")
        lines.append(ts["segment"])
        lines.append("")
    return "\n".join(lines)


def _split_sentence_evenly(sentence_words: List[dict], max_words: int) -> List[dict]:
    total_words = len(sentence_words)
    if not sentence_words:
        return []
    if max_words == -1 or total_words <= max_words:
        return [{
            "start": sentence_words[0]["start"],
            "end": sentence_words[-1]["end"],
            "segment": " ".join(w["text"] for w in sentence_words),
        }]
    num_lines = math.ceil(total_words / max_words)
    base = total_words // num_lines
    extra = total_words % num_lines
    segments, idx = [], 0
    for i in range(num_lines):
        count = base + (1 if i < extra else 0)
        chunk = sentence_words[idx:idx + count]
        if not chunk:
            continue
        segments.append({
            "start": chunk[0]["start"],
            "end": chunk[-1]["end"],
            "segment": " ".join(w["text"] for w in chunk),
        })
        idx += count
    return segments


def process_words(words: List[dict], segment_strategy: str, max_chars: int, max_words: int,
                  pause_threshold: float) -> list:
    """Group word-level {text, start, end} dicts into subtitle segments using the same strategies as the
    Parakeet service (sentence / word / char), but on faster-whisper's real word end times."""
    if not words:
        return []
    all_segments = []

    if segment_strategy == "sentence":
        buffer = []
        for i, word in enumerate(words):
            buffer.append(word)
            is_last = (i == len(words) - 1)
            pause_after = (words[i + 1]["start"] - word["end"]) if not is_last else 0
            is_sentence_end = (
                is_last
                or pause_after >= pause_threshold
                or word["text"].strip().endswith((".", "?", "!"))
            )
            if is_sentence_end and buffer:
                all_segments.extend(_split_sentence_evenly(buffer, max_words))
                buffer = []
    else:
        current = []
        for i, word in enumerate(words):
            current.append(word)
            current_text = " ".join(w["text"] for w in current)
            is_last = (i == len(words) - 1)
            pause_after = (words[i + 1]["start"] - word["end"]) if not is_last else 0
            next_len = (len(words[i + 1]["text"]) + 1) if not is_last else 0

            end_segment = (
                is_last
                or pause_after >= pause_threshold
                or (segment_strategy == "word" and len(current) >= max_words and max_words != -1)
                or (segment_strategy == "char" and len(current_text) + next_len > max_chars)
            )
            if end_segment and current:
                all_segments.append({
                    "start": current[0]["start"],
                    "end": current[-1]["end"],
                    "segment": " ".join(w["text"] for w in current),
                })
                current = []
    return all_segments


def transcribe_audio(audio_path: str, segment_strategy: str, max_chars: int, max_words: int,
                     pause_threshold: float, language: Optional[str] = None) -> dict:
    model = app_state.get("model")
    if not model:
        raise HTTPException(status_code=503, detail="ASR model is not available.")

    # language=None => faster-whisper auto-detects; a 2-letter ISO code forces that language.
    lang = (language or "").strip().lower() or None
    segments, info = model.transcribe(audio_path, language=lang, word_timestamps=True, beam_size=5, vad_filter=False)

    words: List[dict] = []
    full_text_parts: List[str] = []
    for seg in segments:
        full_text_parts.append(seg.text)
        for w in (seg.words or []):
            text = (w.word or "").strip()
            if text:
                words.append({"text": text, "start": float(w.start), "end": float(w.end)})

    segment_timestamps = process_words(words, segment_strategy, max_chars, max_words, pause_threshold)
    return {
        "transcription": "".join(full_text_parts).strip(),
        "segments": segment_timestamps,
        "srt_content": generate_srt_content(segment_timestamps),
        "duration_seconds": float(getattr(info, "duration", 0.0) or 0.0),
    }


# --- Endpoints ---
@app.get("/")
async def root():
    return {"message": "Faster-Whisper Transcription API", "version": "1.0.0"}


@app.get("/health")
async def health():
    if app_state.get("model") is None:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "model_loaded": False, "detail": "ASR model is not available."},
        )
    return {"status": "ok", "model_loaded": True, "device": app_state.get("device")}


def _run(temp_path, segment_strategy, max_chars, max_words, pause_threshold, language=None):
    if max_words == 0:
        raise HTTPException(status_code=400, detail="max_words cannot be 0.")
    return transcribe_audio(temp_path, segment_strategy, max_chars, max_words, pause_threshold, language)


@app.post("/transcribe")
async def transcribe_endpoint(
    file: UploadFile = File(...),
    segment_strategy: str = Form("sentence", enum=["char", "sentence", "word"]),
    max_chars: int = Form(42, gt=10, le=200),
    max_words: int = Form(7, ge=-1, le=50),
    pause_threshold: float = Form(0.8, gt=0.1, le=5.0),
    language: Optional[str] = Form(None),
):
    import shutil
    if not (file.content_type or "").startswith("audio/"):
        raise HTTPException(status_code=400, detail=f"Invalid file type: '{file.content_type}'.")
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename or "audio.wav").suffix) as tf:
            shutil.copyfileobj(file.file, tf)
            temp_path = tf.name
        return JSONResponse(content=_run(temp_path, segment_strategy, max_chars, max_words, pause_threshold, language))
    finally:
        if temp_path and Path(temp_path).exists():
            Path(temp_path).unlink()


class TranscribeBase64Request(BaseModel):
    audio_base64: str
    filename: Optional[str] = "audio.wav"
    segment_strategy: Literal["char", "sentence", "word"] = "sentence"
    max_chars: int = 42
    max_words: int = 7  # -1 preserves full sentences
    pause_threshold: float = 0.8
    language: Optional[str] = None  # None/'' => auto-detect; a 2-letter ISO code forces a language


@app.post("/transcribe_base64")
async def transcribe_base64_endpoint(payload: TranscribeBase64Request):
    temp_path = None
    try:
        b64 = payload.audio_base64
        if "," in b64 and b64.strip().startswith("data:"):
            b64 = b64.split(",", 1)[1]
        with tempfile.NamedTemporaryFile(delete=False, suffix="".join(Path(payload.filename).suffixes)) as f:
            temp_path = Path(f.name)
            f.write(base64.b64decode(b64))
        return JSONResponse(content=_run(
            str(temp_path), payload.segment_strategy, payload.max_chars, payload.max_words,
            payload.pause_threshold, payload.language
        ))
    finally:
        if temp_path and Path(temp_path).exists():
            Path(temp_path).unlink()


if __name__ == "__main__":
    logger.info(f"Starting Faster-Whisper ASR server on port {PORT}...")
    # access_log=False: silence the per-request "GET /health 200 OK" frontend-poll spam.
    uvicorn.run(app, host="0.0.0.0", port=PORT, access_log=False)
