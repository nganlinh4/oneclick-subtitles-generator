"""Build deterministic, content-addressed managed-runtime ZIP parts.

This release tool intentionally packages only an already smoke-tested runtime.
Models remain separate official-revision sources in the delivery manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import zipfile


MAX_PART_UNPACKED = 1_400_000_000
FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)
SKIPPED_SUFFIXES = {".pyc", ".pyo"}
SKIPPED_PARTS = {"__pycache__"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def runtime_files(root: Path) -> list[Path]:
    files = [
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() not in SKIPPED_SUFFIXES
        and not SKIPPED_PARTS.intersection(path.relative_to(root).parts)
    ]
    files.sort(key=lambda path: path.relative_to(root).as_posix())
    if not files or not (root / "python.exe").is_file():
        raise SystemExit("runtime must contain python.exe and at least one file")
    return files


def partition(files: list[Path]) -> list[list[Path]]:
    parts: list[list[Path]] = []
    current: list[Path] = []
    current_size = 0
    for path in files:
        size = path.stat().st_size
        if size > MAX_PART_UNPACKED:
            raise SystemExit(f"unsupported runtime file size: {path}")
        if current and current_size + size > MAX_PART_UNPACKED:
            parts.append(current)
            current = []
            current_size = 0
        current.append(path)
        current_size += size
    if current:
        parts.append(current)
    return parts


def write_part(root: Path, files: list[Path], output: Path) -> list[dict[str, object]]:
    manifest_files: list[dict[str, object]] = []
    with zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        # Level 1 keeps CI/release builds bounded while every byte remains
        # content-addressed and GitHub's per-asset ceiling is enforced by the
        # uncompressed partition size.
        compresslevel=1,
        allowZip64=True,
    ) as archive:
        for path in files:
            relative = path.relative_to(root).as_posix()
            archive_path = f"runtime/{relative}"
            executable = relative.lower().endswith((".exe", ".com"))
            info = zipfile.ZipInfo(archive_path, FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = ((0o755 if executable else 0o644) | stat.S_IFREG) << 16
            with path.open("rb") as source, archive.open(info, "w", force_zip64=True) as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            manifest_files.append(
                {
                    "path": archive_path,
                    "archivePath": archive_path,
                    "sizeBytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                    "executable": executable,
                    "role": "runtime",
                }
            )
    return manifest_files


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()

    runtime = args.runtime.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    files = runtime_files(runtime)
    parts = partition(files)
    sources: list[dict[str, object]] = []
    manifest_files: list[dict[str, object]] = []
    for index, part in enumerate(parts):
        temporary = output / f"{args.id}-{args.version}-part{index + 1:02}.zip"
        entries = write_part(runtime, part, temporary)
        digest = sha256_file(temporary)
        final_name = f"{args.id}-{args.version}-part{index + 1:02}-{digest[:16]}.zip"
        final = output / final_name
        temporary.replace(final)
        source_index = len(sources)
        for entry in entries:
            entry["sourceIndex"] = source_index
        manifest_files.extend(entries)
        sources.append(
            {
                "kind": "zip",
                "asset": final_name,
                "sizeBytes": final.stat().st_size,
                "sha256": digest,
                "urls": [
                    "https://github.com/nganlinh4/oneclick-subtitles-generator/"
                    f"releases/download/osg-runtime-bundles-v1/{final_name}"
                ],
            }
        )
    result = {
        "schemaVersion": 1,
        "id": args.id,
        "version": args.version,
        "unpackedSizeBytes": sum(entry["sizeBytes"] for entry in manifest_files),
        "sources": sources,
        "files": manifest_files,
    }
    manifest_path = output / f"{args.id}-{args.version}.runtime.json"
    manifest_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(manifest_path)


if __name__ == "__main__":
    main()
