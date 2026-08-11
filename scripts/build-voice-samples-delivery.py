"""Build the deterministic, platform-neutral Gemini voice-preview archive.

This is an authoring tool only. The desktop host never reads ``--source-dir``;
debug and release builds install the exact remote archive described by the
checked-in delivery catalog.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path


VOICE_FILE = re.compile(r"chirp3-hd-([a-z0-9]+)\.wav")
EXPECTED_VOICES = (
    "achernar", "achird", "algenib", "algieba", "alnilam", "aoede", "autonoe",
    "callirrhoe", "charon", "despina", "enceladus", "erinome", "fenrir", "gacrux",
    "iapetus", "kore", "laomedeia", "leda", "orus", "puck", "pulcherrima",
    "rasalgethi", "sadachbia", "sadaltager", "schedar", "sulafat", "umbriel",
    "vindemiatrix", "zephyr", "zubenelgenubi",
)
FIXED_TIMESTAMP = (2026, 8, 11, 0, 0, 0)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build(source_dir: Path, output_dir: Path, version: str) -> dict[str, object]:
    files = sorted(source_dir.glob("*.wav"), key=lambda path: path.name)
    voices = tuple(
        match.group(1)
        for path in files
        if (match := VOICE_FILE.fullmatch(path.name)) is not None
    )
    if voices != tuple(sorted(EXPECTED_VOICES)) or len(files) != len(EXPECTED_VOICES):
        raise SystemExit("voice sample source must contain the exact reviewed 30-file inventory")

    output_dir.mkdir(parents=True, exist_ok=True)
    temporary = output_dir / "voice-samples.tmp.zip"
    records: list[dict[str, object]] = []
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            data = path.read_bytes()
            if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
                raise SystemExit(f"invalid WAV sample: {path.name}")
            relative = f"samples/{path.name}"
            info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
            records.append({
                "path": relative,
                "sizeBytes": len(data),
                "sha256": sha256(data),
                "executable": False,
                "role": "runtime",
            })

    archive_data = temporary.read_bytes()
    archive_hash = sha256(archive_data)
    asset = f"gemini-voice-samples-{version}-{archive_hash[:16]}.zip"
    final = output_dir / asset
    temporary.replace(final)
    result = {
        "version": version,
        "asset": asset,
        "sizeBytes": len(archive_data),
        "sha256": archive_hash,
        "unpackedSizeBytes": sum(int(record["sizeBytes"]) for record in records),
        "files": records,
    }
    (output_dir / "voice-samples.build.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return result


def catalog(result: dict[str, object]) -> dict[str, object]:
    release = {
        **result,
        "sourceUrl": (
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/"
            f"osg-runtime-bundles-v1/{result['asset']}"
        ),
        "sampleRelativePath": "samples/chirp3-hd-achernar.wav",
    }
    return {
        "schemaVersion": 1,
        "commands": {
            "status": "voice_samples_status",
            "install": "voice_samples_install",
            "cancel": "voice_samples_cancel",
            "resolve": "voice_sample_resolve",
            "remove": "voice_samples_remove",
        },
        "platforms": {
            platform: {"releases": [release]}
            for platform in ("linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64")
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--version", default="2026.08.11")
    parser.add_argument("--catalog-output", type=Path)
    args = parser.parse_args()
    result = build(args.source_dir.resolve(), args.output_dir.resolve(), args.version)
    if args.catalog_output:
        args.catalog_output.write_text(
            json.dumps(catalog(result), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
