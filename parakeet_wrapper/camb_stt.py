"""Camb AI STT adapter — drop-in alternative to Parakeet's transcribe endpoints.

Mounted into the Parakeet FastAPI app via ``app.include_router(camb_router)``.

Uses the real camb-sdk Python shape:
- Import: ``from camb.client import CambAI`` (the top-level ``from camb import CambAI``
  crashes on Python 3.14 due to a broken lazy-import map in the SDK).
- Languages are NUMERIC ids. Resolve short codes via ``client.languages.get_source_languages``.
- ``create_transcription`` → ``task_id`` (dict) → poll ``get_transcription_task_status``
  until ``status == 'SUCCESS'`` → ``get_transcription_result(run_id=...)`` → ``.transcript``
  (list of ``{start, end, text, speaker}``).

Auth: ``CAMB_API_KEY`` env var.
"""
from __future__ import annotations

import base64
import logging
import os
import tempfile
import time
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

logger = logging.getLogger(__name__)

try:
    from camb.client import CambAI  # type: ignore
    HAS_CAMB = True
except Exception:  # pragma: no cover
    CambAI = None  # type: ignore
    HAS_CAMB = False
    logger.warning("camb-sdk not installed — Camb STT adapter will return 503")

camb_router = APIRouter(prefix="/camb", tags=["camb-stt"])


def _client():
    if not HAS_CAMB:
        raise HTTPException(status_code=503, detail="camb-sdk not installed")
    api_key = os.environ.get("CAMB_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="CAMB_API_KEY not set")
    return CambAI(api_key=api_key)


def _get(obj, key, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _resolve_lang_id(client, code: str) -> int:
    if not code:
        return 1
    low = code.strip().lower()
    base = low.split("-")[0].split("_")[0]
    langs = client.languages.get_source_languages()
    def sn(l): return (_get(l, "short_name") or "").lower()
    for l in langs:
        if sn(l) == low:
            return _get(l, "id")
    for l in langs:
        if sn(l).startswith(base):
            return _get(l, "id")
    return 1  # fall back to en-us


def _poll(status_fn, task_id: str, interval: float = 3.0, timeout: float = 900.0):
    start = time.time()
    while time.time() - start < timeout:
        res = status_fn(task_id=task_id)
        st = _get(res, "status")
        if st == "SUCCESS":
            return _get(res, "run_id")
        if st in ("ERROR", "FAILURE", "REVOKED"):
            reason = _get(res, "exception_reason") or _get(res, "message") or st
            raise RuntimeError(f"Camb task {task_id} failed: {reason}")
        time.sleep(interval)
    raise TimeoutError(f"Camb task {task_id} timed out after {timeout}s")


def _fmt_ts(t: float) -> str:
    if t < 0:
        t = 0.0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _transcribe_path(audio_path: str, language: str = "en") -> dict:
    """Shared helper — runs the full Camb transcription flow against a file path."""
    client = _client()
    lang_id = _resolve_lang_id(client, language)
    with open(audio_path, "rb") as fh:
        created = client.transcription.create_transcription(
            media_file=fh, language=lang_id
        )
    task_id = _get(created, "task_id")
    if not task_id:
        raise RuntimeError(f"Camb create_transcription returned no task_id: {created!r}")
    run_id = _poll(client.transcription.get_transcription_task_status, task_id)
    result = client.transcription.get_transcription_result(run_id=run_id)
    segs = _get(result, "transcript") or _get(result, "segments") or []
    normalized = []
    text_parts = []
    srt_lines = []
    for i, s in enumerate(segs, start=1):
        start_t = float(_get(s, "start", 0.0) or 0.0)
        end_t = float(_get(s, "end", start_t) or start_t)
        seg_text = (_get(s, "text") or "").strip()
        speaker = _get(s, "speaker") or ""
        normalized.append({
            "start": start_t, "end": end_t, "text": seg_text, "speaker": speaker,
        })
        text_parts.append(seg_text)
        srt_lines.append(f"{i}\n{_fmt_ts(start_t)} --> {_fmt_ts(end_t)}\n{seg_text}\n")
    return {
        "text": " ".join(p for p in text_parts if p),
        "srt": "\n".join(srt_lines),
        "segments": normalized,
        "language": language,
    }


class Base64Payload(BaseModel):
    audio_base64: str
    filename: Optional[str] = "segment.wav"
    language: Optional[str] = "en"
    # Present for Parakeet shape-compat; Camb segments internally.
    segment_strategy: Optional[str] = "sentence"
    max_chars: Optional[int] = 60
    max_words: Optional[int] = 7
    pause_threshold: Optional[float] = 0.8


@camb_router.get("/health")
def camb_health():
    return {
        "available": HAS_CAMB and bool(os.environ.get("CAMB_API_KEY")),
        "sdk_installed": HAS_CAMB,
        "api_key_set": bool(os.environ.get("CAMB_API_KEY")),
    }


@camb_router.post("/transcribe_base64")
def camb_transcribe_base64(payload: Base64Payload):
    suffix = os.path.splitext(payload.filename or "segment.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(base64.b64decode(payload.audio_base64))
        tmp_path = tmp.name
    try:
        return _transcribe_path(tmp_path, payload.language or "en")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Camb transcribe_base64 failed")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@camb_router.post("/transcribe")
async def camb_transcribe(file: UploadFile = File(...), language: str = Form("en")):
    suffix = os.path.splitext(file.filename or "segment.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        return _transcribe_path(tmp_path, language)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Camb transcribe failed")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
