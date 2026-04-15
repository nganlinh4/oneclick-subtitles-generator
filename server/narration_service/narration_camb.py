"""Camb AI narration blueprint (Flask).

Provides TTS, transcription, and dubbing endpoints that mirror the shape of
the existing Edge TTS / gTTS blueprint so the frontend can stream SSE the
same way.

Uses the REAL camb-sdk Python shape (see integrations/CAMB_API_NOTES.md):
- ``from camb.client import CambAI`` (NOT ``from camb import CambAI`` — broken on Py 3.14)
- Languages are NUMERIC ids from ``client.languages.get_source_languages()``
- Transcription / translation / dubbing / task-based TTS all follow:
  create → poll ``get_*_task_status`` → fetch ``get_*_result(run_id=...)``
- Streaming TTS (preferred, low-latency): ``client.text_to_speech.tts(...)``
  returns ``Iterator[bytes]`` of WAV chunks. Requires ``voice_id`` and an
  ``output_configuration`` with ``format='wav'`` to get real WAV.

Auth: ``CAMB_API_KEY`` env var.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from typing import Optional

from flask import Blueprint, Response, jsonify, request

try:
    from .narration_config import OUTPUT_AUDIO_DIR  # type: ignore
    from .directory_utils import ensure_subtitle_directory, get_next_file_number  # type: ignore
except Exception:  # pragma: no cover
    OUTPUT_AUDIO_DIR = tempfile.gettempdir()

    def ensure_subtitle_directory(subtitle_id):  # type: ignore
        d = os.path.join(OUTPUT_AUDIO_DIR, f"subtitle_{subtitle_id}")
        os.makedirs(d, exist_ok=True)
        return d

    def get_next_file_number(d):  # type: ignore
        return len([f for f in os.listdir(d) if f.endswith('.wav')]) + 1

logger = logging.getLogger(__name__)
camb_bp = Blueprint('narration_camb', __name__)

try:
    from camb.client import CambAI  # type: ignore
    from camb.types.stream_tts_output_configuration import StreamTtsOutputConfiguration  # type: ignore
    HAS_CAMB = True
except Exception:  # pragma: no cover
    CambAI = None  # type: ignore
    StreamTtsOutputConfiguration = None  # type: ignore
    HAS_CAMB = False
    logger.warning("camb-sdk not installed — Camb blueprint will return 503")

DEFAULT_VOICE_ID = int(os.environ.get('CAMB_DEFAULT_VOICE_ID', '156549'))


def _get(obj, key, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _get_client():
    api_key = os.environ.get('CAMB_API_KEY')
    if not api_key:
        raise RuntimeError('CAMB_API_KEY not set')
    if not HAS_CAMB:
        raise RuntimeError('camb-sdk not installed — run: uv pip install camb-sdk')
    return CambAI(api_key=api_key)


_SRC_LANGS: Optional[list] = None
_TGT_LANGS: Optional[list] = None


def _resolve_lang(list_langs, code: str) -> Optional[int]:
    if not code:
        return None
    low = str(code).strip().lower()
    base = low.split('-')[0].split('_')[0]

    def sn(l):
        return (_get(l, 'short_name') or '').lower()

    for l in list_langs:
        if sn(l) == low:
            return _get(l, 'id')
    for l in list_langs:
        if sn(l).startswith(base):
            return _get(l, 'id')
    return None


def _source_lang_id(client, code: str) -> int:
    global _SRC_LANGS
    if _SRC_LANGS is None:
        _SRC_LANGS = client.languages.get_source_languages()
    return _resolve_lang(_SRC_LANGS, code) or 1


def _target_lang_id(client, code: str) -> int:
    global _TGT_LANGS
    if _TGT_LANGS is None:
        _TGT_LANGS = client.languages.get_target_languages()
    return _resolve_lang(_TGT_LANGS, code) or 139


def _poll(status_fn, task_id: str, interval: float = 3.0, timeout: float = 900.0):
    start = time.time()
    while time.time() - start < timeout:
        res = status_fn(task_id=task_id)
        st = _get(res, 'status')
        if st == 'SUCCESS':
            return _get(res, 'run_id')
        if st in ('ERROR', 'FAILURE', 'REVOKED'):
            reason = _get(res, 'exception_reason') or _get(res, 'message') or st
            raise RuntimeError(f'Camb task {task_id} failed: {reason}')
        time.sleep(interval)
    raise TimeoutError(f'Camb task {task_id} timed out after {timeout}s')


def _save_audio(audio_bytes: bytes, subtitle_id, method: str = 'camb') -> str:
    subtitle_dir = ensure_subtitle_directory(subtitle_id)
    n = get_next_file_number(subtitle_dir)
    filename = f"{method}_{n}.wav"
    path = os.path.join(subtitle_dir, filename)
    with open(path, 'wb') as f:
        f.write(audio_bytes)
    return path


# ------------------------------ routes ------------------------------------

@camb_bp.route('/camb/health', methods=['GET'])
def health():
    return jsonify({
        'available': HAS_CAMB and bool(os.environ.get('CAMB_API_KEY')),
        'sdk_installed': HAS_CAMB,
        'api_key_set': bool(os.environ.get('CAMB_API_KEY')),
    })


@camb_bp.route('/camb/voices', methods=['GET'])
def voices():
    try:
        api_key = os.environ.get('CAMB_API_KEY')
        if not api_key:
            return jsonify({'error': 'CAMB_API_KEY not set'}), 503
        import urllib.request
        req = urllib.request.Request(
            'https://client.camb.ai/apis/list-voices',
            headers={'x-api-key': api_key},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode('utf-8'))
        lang = request.args.get('language', '').lower()
        if lang:
            data = [v for v in data if lang in str(v.get('language') or '').lower()]
        return jsonify({'count': len(data), 'voices': data[:200]})
    except Exception as e:
        logger.exception('voices failed')
        return jsonify({'error': str(e)}), 500


@camb_bp.route('/camb/generate', methods=['POST'])
def generate():
    payload = request.get_json(silent=True) or {}
    text = payload.get('text', '')
    if not text or not text.strip():
        return jsonify({'error': 'text is required'}), 400
    language = payload.get('language', 'en-us')
    speech_model = payload.get('speech_model', 'mars-flash')
    voice_id = int(payload.get('voice_id') or DEFAULT_VOICE_ID)
    subtitle_id = payload.get('subtitle_id')
    try:
        client = _get_client()
        chunks = client.text_to_speech.tts(
            text=text,
            language=language,
            speech_model=speech_model,
            voice_id=voice_id,
            output_configuration=StreamTtsOutputConfiguration(format='wav', sample_rate=22050),
        )
        buf = bytearray()
        for chunk in chunks:
            if isinstance(chunk, (bytes, bytearray)):
                buf.extend(chunk)
        audio = bytes(buf)
        if subtitle_id is not None:
            saved = _save_audio(audio, subtitle_id)
            return jsonify({'ok': True, 'path': saved, 'bytes': len(audio)})
        return Response(audio, mimetype='audio/wav')
    except Exception as e:
        logger.exception('generate failed')
        return jsonify({'error': str(e)}), 500


@camb_bp.route('/camb/transcribe', methods=['POST'])
def transcribe():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'file field required'}), 400
    language = request.form.get('language', 'en')
    suffix = os.path.splitext(f.filename or 'segment.wav')[1] or '.wav'
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        f.save(tmp.name)
        tmp_path = tmp.name
    try:
        client = _get_client()
        lang_id = _source_lang_id(client, language)
        with open(tmp_path, 'rb') as fh:
            created = client.transcription.create_transcription(
                media_file=fh, language=lang_id,
            )
        task_id = _get(created, 'task_id')
        if not task_id:
            raise RuntimeError(f'no task_id from create_transcription: {created!r}')
        run_id = _poll(client.transcription.get_transcription_task_status, task_id)
        result = client.transcription.get_transcription_result(run_id=run_id)
        segs = _get(result, 'transcript') or []
        out = [{
            'start': float(_get(s, 'start', 0.0) or 0.0),
            'end': float(_get(s, 'end', 0.0) or 0.0),
            'text': _get(s, 'text', '') or '',
            'speaker': _get(s, 'speaker', '') or '',
        } for s in segs]
        return jsonify({'segments': out, 'language': language})
    except Exception as e:
        logger.exception('transcribe failed')
        return jsonify({'error': str(e)}), 500
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@camb_bp.route('/camb/dub', methods=['POST'])
def dub():
    payload = request.get_json(silent=True) or {}
    video_url = payload.get('video_url', '')
    if not video_url.startswith(('http://', 'https://')):
        return jsonify({'error': 'video_url must be a public http(s) URL'}), 400
    source_language = payload.get('source_language', 'en')
    target_language = payload.get('target_language', 'zh')
    try:
        client = _get_client()
        src = _source_lang_id(client, source_language)
        tgt = _target_lang_id(client, target_language)
        created = client.dub.create_dub(
            video_url=video_url,
            source_language=src,
            target_language=tgt,
        )
        task_id = _get(created, 'task_id')
        if not task_id:
            raise RuntimeError(f'no task_id from create_dub: {created!r}')
        run_id = _poll(
            client.dub.get_dubbing_status, task_id,
            interval=5.0, timeout=1800.0,
        )
        info = client.dub.get_dubbed_run_info(run_id=run_id)
        return jsonify({'run_id': run_id,
                         'info': info if isinstance(info, dict) else info.model_dump()})
    except Exception as e:
        logger.exception('dub failed')
        return jsonify({'error': str(e)}), 500
