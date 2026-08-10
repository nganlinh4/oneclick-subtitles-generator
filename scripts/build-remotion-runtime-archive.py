"""Create the deterministic, file-only managed Remotion ZIP consumed by the Rust installer."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import shutil
import stat
import zipfile


FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)
MAX_FILES = 100_000
MAX_BYTES = 4 * 1024 * 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    root = args.root.resolve(strict=True)
    output = args.output.resolve()
    if not root.is_dir() or output.exists() or output.parent == root:
        raise SystemExit("output must be a new file outside the runtime root")
    files = sorted((entry for entry in root.rglob("*") if entry.is_file()), key=lambda entry: entry.relative_to(root).as_posix())
    total = sum(entry.stat().st_size for entry in files)
    if not files or len(files) > MAX_FILES or total > MAX_BYTES:
        raise SystemExit("runtime archive exceeds its fixed bounds")

    with zipfile.ZipFile(
        output,
        "x",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=1,
        allowZip64=True,
    ) as archive:
        for source in files:
            relative = source.relative_to(root).as_posix()
            executable = relative.lower().endswith((".exe", ".com"))
            info = zipfile.ZipInfo(relative, FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = ((0o755 if executable else 0o644) | stat.S_IFREG) << 16
            with source.open("rb") as reader, archive.open(info, "w", force_zip64=True) as writer:
                shutil.copyfileobj(reader, writer, length=1024 * 1024)

    digest = sha256_file(output)
    print(f"{output.name} {output.stat().st_size} {digest}")


if __name__ == "__main__":
    main()
