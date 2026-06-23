"""
Shared helpers for the OSG ASR sidecars (faster-whisper, qwen3-asr, …).

Every sidecar turns a flat list of word dicts `[{text, start, end}]` (in seconds) into subtitle
segments + SRT using the SAME strategies (sentence / word / char), so segmentation behaves identically
across engines. Import via the engine's sys.path including the asr_services/ dir:

    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # -> asr_services/
    from asr_common import process_words, generate_srt_content
"""

import math
import datetime
from typing import List


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


def _split_sentence_evenly(sentence_words: List[dict], max_words: int, joiner: str = " ") -> List[dict]:
    total_words = len(sentence_words)
    if not sentence_words:
        return []
    if max_words == -1 or total_words <= max_words:
        return [{
            "start": sentence_words[0]["start"],
            "end": sentence_words[-1]["end"],
            "segment": joiner.join(w["text"] for w in sentence_words),
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
            "segment": joiner.join(w["text"] for w in chunk),
        })
        idx += count
    return segments


def process_words(words: List[dict], segment_strategy: str, max_chars: int, max_words: int,
                  pause_threshold: float, joiner: str = " ") -> list:
    """Group word-level {text, start, end} dicts (seconds) into subtitle segments.
    Strategies: 'sentence' (break on pause/punctuation, then evenly split long sentences by max_words),
    'word' (break on pause or max_words), 'char' (break on pause or max_chars).
    `joiner` joins tokens within a segment — ' ' for space-delimited languages, '' for CJK char tokens."""
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
                or word["text"].strip().endswith((".", "?", "!", "。", "！", "？"))
            )
            if is_sentence_end and buffer:
                all_segments.extend(_split_sentence_evenly(buffer, max_words, joiner))
                buffer = []
    else:
        current = []
        for i, word in enumerate(words):
            current.append(word)
            current_text = joiner.join(w["text"] for w in current)
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
                    "segment": joiner.join(w["text"] for w in current),
                })
                current = []
    return all_segments
