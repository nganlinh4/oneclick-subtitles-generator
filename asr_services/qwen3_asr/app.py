"""
Qwen3-ASR FastAPI sidecar (OSG on-demand GPU engine). Serves Qwen3-ASR-1.7B and -0.6B (model dir from
env), with WORD timestamps from the companion Qwen3-ForcedAligner-0.6B. Same response contract as the
other sidecars: {transcription, segments:[{start,end,segment}], srt_content, duration_seconds}.

Env (set by engineSpawn): ASR_MODEL_DIR (the Qwen3-ASR model dir), ASR_ALIGNER_DIR (the forced-aligner
dir), ASR_PORT (bind port). The qwen-asr package auto-chunks long audio on silence and re-bases the
per-chunk timestamps, so no manual segmentation is needed here — we just map its word stream.
"""

import os
import gc
import base64
import logging
import tempfile
import sys
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, Literal, List

import uvicorn

# --- CUDA DLL bootstrap (torch libs on the Windows search path) ---
_CUDA_OK = False
try:
    import torch
    _CUDA_OK = bool(torch.cuda.is_available())
    _torch_lib = os.path.join(os.path.dirname(torch.__file__), "lib")
    if os.path.isdir(_torch_lib):
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(_torch_lib)
            except Exception:
                pass
        os.environ["PATH"] = _torch_lib + os.pathsep + os.environ.get("PATH", "")
except Exception as _e:
    logging.getLogger(__name__).debug(f"torch CUDA bootstrap skipped: {_e}")


# --- Prefer the bundled ffmpeg over any system install ---
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
                return


_prepend_bundled_ffmpeg_to_path()

# Shared segmentation / SRT helpers.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # -> asr_services/
from asr_common import process_words, generate_srt_content  # noqa: E402

from qwen_asr import Qwen3ASRModel  # noqa: E402
from fastapi import FastAPI, UploadFile, File, HTTPException, Form  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

MODEL_DIR = os.getenv("ASR_MODEL_DIR", "")
ALIGNER_DIR = os.getenv("ASR_ALIGNER_DIR", "")
PORT = int(os.getenv("ASR_PORT", "3041"))
app_state = {}

# ISO 639-1 -> the language NAME qwen-asr expects. The forced aligner supports these; others auto-detect
# (transcript still returned, but word timestamps may be unavailable -> single-segment fallback).
QWEN_LANG = {
    "zh": "Chinese", "en": "English", "fr": "French", "de": "German", "it": "Italian",
    "ja": "Japanese", "ko": "Korean", "pt": "Portuguese", "ru": "Russian", "es": "Spanish",
}
# Languages whose tokens are characters (no inter-token spaces) when building segment text.
CJK_LANGS = {"Chinese", "Japanese", "Cantonese"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    device = "cuda:0" if _CUDA_OK else "cpu"
    dtype = torch.bfloat16 if _CUDA_OK else torch.float32
    logger.info(f"Loading Qwen3-ASR from '{MODEL_DIR}' on {device}...")
    try:
        kwargs = dict(dtype=dtype, device_map=device, max_new_tokens=448)
        if ALIGNER_DIR and os.path.isdir(ALIGNER_DIR):
            kwargs["forced_aligner"] = ALIGNER_DIR
            kwargs["forced_aligner_kwargs"] = dict(dtype=dtype, device_map=device)
        else:
            logger.warning("No forced aligner dir — transcripts will lack word timestamps.")
        app_state["model"] = Qwen3ASRModel.from_pretrained(MODEL_DIR, **kwargs)
        app_state["device"] = device
        app_state["has_aligner"] = bool(ALIGNER_DIR and os.path.isdir(ALIGNER_DIR))
        logger.info(f"Qwen3-ASR loaded on {device}.")
    except Exception as e:
        logger.error(f"Failed to load Qwen3-ASR: {e}", exc_info=True)
        app_state["model"] = None

    yield

    logger.info("Cleaning up resources...")
    app_state.clear()
    gc.collect()


app = FastAPI(title="Qwen3-ASR Transcription API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)


def transcribe_audio(audio_path: str, segment_strategy: str, max_chars: int, max_words: int,
                     pause_threshold: float, language: Optional[str] = None) -> dict:
    model = app_state.get("model")
    if not model:
        raise HTTPException(status_code=503, detail="ASR model is not available.")

    qwen_lang = QWEN_LANG.get((language or "").strip().lower()) if language else None
    results = model.transcribe(audio=[audio_path], language=qwen_lang, return_time_stamps=True)
    res = results[0]

    items = list(res.time_stamps) if getattr(res, "time_stamps", None) else []
    words = [{"text": it.text, "start": float(it.start_time), "end": float(it.end_time)} for it in items]

    joiner = "" if (getattr(res, "language", "") in CJK_LANGS) else " "
    if words:
        segments = process_words(words, segment_strategy, max_chars, max_words, pause_threshold, joiner)
        duration = words[-1]["end"]
    else:
        # No word timing (aligner doesn't cover this language) — keep the transcript as one segment.
        duration = 0.0
        segments = [{"start": 0.0, "end": 0.0, "segment": res.text.strip()}] if res.text.strip() else []

    return {
        "transcription": res.text.strip(),
        "segments": segments,
        "srt_content": generate_srt_content(segments),
        "duration_seconds": duration,
    }


@app.get("/")
async def root():
    return {"message": "Qwen3-ASR Transcription API", "version": "1.0.0"}


@app.get("/health")
async def health():
    if app_state.get("model") is None:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "model_loaded": False, "detail": "ASR model is not available."},
        )
    return {"status": "ok", "model_loaded": True, "device": app_state.get("device"), "has_aligner": app_state.get("has_aligner")}


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
    max_words: int = 7
    pause_threshold: float = 0.8
    language: Optional[str] = None


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
    logger.info(f"Starting Qwen3-ASR server on port {PORT}...")
    uvicorn.run(app, host="0.0.0.0", port=PORT, access_log=False)
