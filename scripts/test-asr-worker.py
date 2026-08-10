"""Hermetic syntax and wire-contract tests for the packaged ASR worker."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "crates" / "osg-asr" / "worker" / "osg_asr_worker.py"
PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 64 * 1024


def encode_frame(value: dict[str, object]) -> bytes:
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(payload)) + payload


def decode_frames(data: bytes) -> list[dict[str, object]]:
    frames: list[dict[str, object]] = []
    offset = 0
    while offset < len(data):
        if len(data) - offset < 4:
            raise AssertionError("truncated frame header")
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        offset += 4
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise AssertionError("invalid response frame length")
        end = offset + length
        if end > len(data):
            raise AssertionError("truncated frame body")
        value = json.loads(data[offset:end].decode("utf-8"))
        if not isinstance(value, dict):
            raise AssertionError("response frame is not an object")
        frames.append(value)
        offset = end
    return frames


def run_worker(payload: bytes) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [sys.executable, "-I", "-B", "-u", "-X", "utf8", str(WORKER)],
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=5,
    )


class AsrWorkerContractTests(unittest.TestCase):
    def test_worker_source_compiles_with_the_pinned_python(self) -> None:
        source = WORKER.read_text(encoding="utf-8")
        compile(source, str(WORKER), "exec", dont_inherit=True)

    def test_invalid_model_capability_is_framed_and_redacted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            secret_marker = "never-leak-model-capability"
            missing_model = Path(directory) / secret_marker
            request = {
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": 41,
                "engine": "faster-whisper-turbo",
                "modelPath": str(missing_model.resolve()),
            }
            result = run_worker(encode_frame(request))

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            decode_frames(result.stdout),
            [
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": 41,
                    "sequence": 0,
                    "event": "phase",
                    "phase": "model_loading",
                },
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": 41,
                    "sequence": 1,
                    "event": "error",
                    "code": "invalid_request",
                },
            ],
        )
        combined_output = result.stdout + result.stderr
        self.assertNotIn(secret_marker.encode("utf-8"), combined_output)
        self.assertNotIn(str(missing_model).encode("utf-8"), combined_output)

    def test_protocol_mismatch_fails_closed_before_model_loading(self) -> None:
        result = run_worker(
            encode_frame(
                {
                    "protocolVersion": PROTOCOL_VERSION + 1,
                    "requestId": 7,
                    "engine": "faster-whisper-turbo",
                    "modelPath": "not-a-capability",
                }
            )
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")

    def test_oversized_frame_is_rejected_without_a_response(self) -> None:
        result = run_worker(struct.pack(">I", MAX_REQUEST_BYTES + 1))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(
            result.stderr.splitlines(),
            [b"ASR protocol read failed: ValueError"],
        )


if __name__ == "__main__":
    unittest.main()
