"""Build reproducible, minimal Windows runtimes for network speech providers.

Every input byte is bound by ``provider-runtime-windows.lock.json``.  Python and
wheels are downloaded from their immutable upstream URLs; only the assembled,
content-addressed runtime ZIP is hosted in the OSG bundle pool.
"""

from __future__ import annotations

import argparse
from email.parser import BytesParser
import hashlib
import json
import shutil
import stat
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen
import zipfile


FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)
POOL = (
    "https://github.com/nganlinh4/oneclick-subtitles-generator/"
    "releases/download/osg-runtime-bundles-v1/"
)
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
MAX_RUNTIME_FILES = 20_000
MAX_RUNTIME_BYTES = 256 * 1024 * 1024
REQUIRED_KEYS = {
    "name", "version", "asset", "sizeBytes", "sha256", "sourceUrl", "license"
}


def package_id(value: str) -> str:
    normalized = value.strip().lower().replace("_", "-")
    if (not normalized or normalized.startswith("-") or normalized.endswith("-")
            or any(not (character.isalnum() or character == "-") for character in normalized)):
        raise SystemExit(f"invalid locked package identity: {value!r}")
    return normalized


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def checked_relative(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if (not value or "\\" in value or value != path.as_posix() or path.is_absolute()
            or any(part in {"", ".", ".."} for part in path.parts)):
        raise SystemExit(f"unsafe locked path: {value!r}")
    return path


def validate_upstream(asset: dict, *, python: bool) -> None:
    parsed = urlparse(asset.get("sourceUrl", ""))
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port
            or parsed.query or parsed.fragment):
        raise SystemExit("locked upstream URL is invalid")
    if python:
        release = asset.get("release")
        expected = f"/astral-sh/python-build-standalone/releases/download/{release}/"
        if parsed.hostname != "github.com" or not parsed.path.startswith(expected):
            raise SystemExit("Python runtime must use its exact official tagged release")
    elif parsed.hostname != "files.pythonhosted.org" or not parsed.path.startswith("/packages/"):
        raise SystemExit("provider wheel must use its exact official PyPI file URL")
    if unquote(parsed.path.rsplit("/", 1)[-1]) != asset.get("asset"):
        raise SystemExit("locked upstream URL does not match its asset")


def fetch(asset: dict, cache: Path) -> Path:
    if set(asset) < {"asset", "sizeBytes", "sha256", "sourceUrl"}:
        raise SystemExit("locked asset is incomplete")
    name = checked_relative(asset["asset"])
    if len(name.parts) != 1:
        raise SystemExit("locked asset must be a filename")
    size = asset["sizeBytes"]
    if not isinstance(size, int) or not 0 < size <= MAX_DOWNLOAD_BYTES:
        raise SystemExit("locked asset exceeds the download bound")
    digest = asset["sha256"]
    if not isinstance(digest, str) or len(digest) != 64:
        raise SystemExit("locked asset digest is invalid")
    target = cache / name.name
    if target.is_file() and target.stat().st_size == size and sha256_file(target) == digest:
        return target
    partial = target.with_suffix(target.suffix + ".partial")
    partial.unlink(missing_ok=True)
    request = Request(asset["sourceUrl"], headers={"User-Agent": "OSG-provider-runtime/1"})
    try:
        with urlopen(request, timeout=60) as response, partial.open("xb") as output:
            if response.status != 200:
                raise SystemExit("locked upstream returned an unexpected status")
            received = 0
            while block := response.read(1024 * 1024):
                received += len(block)
                if received > size:
                    raise SystemExit("locked upstream exceeded its byte bound")
                output.write(block)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    if partial.stat().st_size != size or sha256_file(partial) != digest:
        partial.unlink(missing_ok=True)
        raise SystemExit(f"locked upstream integrity mismatch: {name.name}")
    partial.replace(target)
    return target


def extract_python(archive_path: Path, destination: Path) -> Path:
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        if not members or len(members) > MAX_RUNTIME_FILES:
            raise SystemExit("Python archive inventory is invalid")
        total = 0
        for member in members:
            relative = checked_relative(member.name)
            if relative.parts[0] != "python" or not member.isfile():
                raise SystemExit("Python archive must contain regular files under python/")
            total += member.size
            if total > MAX_RUNTIME_BYTES:
                raise SystemExit("Python archive exceeds the runtime bound")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit("Python archive entry could not be read")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
    python = destination / "python/python.exe"
    if not python.is_file():
        raise SystemExit("Python archive does not contain python.exe")
    return destination / "python"


def prune_python(root: Path, paths: list[str]) -> None:
    for value in paths:
        relative = checked_relative(value)
        target = root.joinpath(*relative.parts)
        if not target.exists():
            raise SystemExit(f"locked Python prune path is missing: {value}")
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()


def extract_wheel(wheel: Path, destination: Path, package: dict) -> None:
    with zipfile.ZipFile(wheel) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > MAX_RUNTIME_FILES:
            raise SystemExit(f"wheel inventory is invalid: {wheel.name}")
        metadata_entries = [
            entry for entry in entries if entry.filename.endswith(".dist-info/METADATA")
        ]
        if len(metadata_entries) != 1 or metadata_entries[0].file_size > 1024 * 1024:
            raise SystemExit(f"wheel metadata is invalid: {wheel.name}")
        metadata = BytesParser().parsebytes(archive.read(metadata_entries[0]))
        if (package_id(metadata.get("Name", "")) != package_id(package["name"])
                or metadata.get("Version") != package["version"]):
            raise SystemExit(f"wheel identity differs from the lock: {wheel.name}")
        for entry in entries:
            relative = checked_relative(entry.filename)
            if entry.is_dir() or ".data" in relative.parts:
                raise SystemExit(f"wheel uses an unsupported install scheme: {wheel.name}")
            mode = (entry.external_attr >> 16) & 0o170_000
            if mode not in {0, stat.S_IFREG}:
                raise SystemExit(f"wheel contains a non-regular entry: {wheel.name}")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                with archive.open(entry) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
            except FileExistsError as error:
                raise SystemExit(f"wheel files collide: {wheel.name}") from error


def validate_notices(site_packages: Path, package_count: int) -> None:
    distributions = sorted(site_packages.glob("*.dist-info"))
    if len(distributions) != package_count:
        raise SystemExit("installed distribution inventory differs from the lock")
    for distribution in distributions:
        metadata = distribution / "METADATA"
        record = distribution / "RECORD"
        notices = [
            path for path in distribution.rglob("*")
            if path.is_file() and any(
                token in path.name.upper() for token in ("LICENSE", "COPYING", "NOTICE")
            )
        ]
        if not metadata.is_file() or not record.is_file() or not notices:
            raise SystemExit(f"distribution notice inventory is incomplete: {distribution.name}")


def runtime_files(root: Path) -> list[Path]:
    files = [
        path for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() not in {".pyc", ".pyo"}
        and "__pycache__" not in path.relative_to(root).parts
    ]
    files.sort(key=lambda path: path.relative_to(root).as_posix())
    total = sum(path.stat().st_size for path in files)
    if len(files) > MAX_RUNTIME_FILES or total > MAX_RUNTIME_BYTES:
        raise SystemExit("provider runtime exceeds its inventory bound")
    return files


def write_runtime(
    root: Path,
    output: Path,
    component: str,
    version: str,
    notice: bytes,
) -> tuple[Path, dict]:
    files = runtime_files(root)
    temporary = output / f"{component}-provider-runtime-{version}.zip"
    manifest_files = []
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            relative = path.relative_to(root).as_posix()
            archive_path = f"runtime/{relative}"
            executable = relative.lower().endswith((".exe", ".com"))
            info = zipfile.ZipInfo(archive_path, FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = ((0o755 if executable else 0o644) | stat.S_IFREG) << 16
            with path.open("rb") as source, archive.open(info, "w", force_zip64=True) as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            manifest_files.append({
                "path": archive_path,
                "archivePath": archive_path,
                "sizeBytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "executable": executable,
                "role": "runtime",
                "sourceIndex": 0,
            })
        notice_path = "licenses/PROVIDER_RUNTIME_NOTICES.json"
        notice_info = zipfile.ZipInfo(notice_path, FIXED_ZIP_TIME)
        notice_info.compress_type = zipfile.ZIP_DEFLATED
        notice_info.external_attr = (0o644 | stat.S_IFREG) << 16
        archive.writestr(notice_info, notice)
        manifest_files.append({
            "path": notice_path,
            "archivePath": notice_path,
            "sizeBytes": len(notice),
            "sha256": hashlib.sha256(notice).hexdigest(),
            "executable": False,
            "role": "license",
            "sourceIndex": 0,
        })
    digest = sha256_file(temporary)
    final = output / f"{component}-provider-runtime-{version}-{digest[:16]}.zip"
    temporary.replace(final)
    source = {
        "kind": "zip", "asset": final.name, "sizeBytes": final.stat().st_size,
        "sha256": digest, "urls": [POOL + final.name],
    }
    manifest = {
        "schemaVersion": 1, "component": component, "platform": "windows-x86_64",
        "version": version, "pythonRelativePath": "runtime/python.exe",
        "modelRelativePath": None, "alignerRelativePath": None,
        "unpackedSizeBytes": sum(item["sizeBytes"] for item in manifest_files),
        "files": manifest_files,
    }
    encoded = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n"
    draft = output / f"{component}-windows-x86_64-{version}.manifest.json"
    draft.write_text(encoded, encoding="utf-8", newline="\n")
    manifest_digest = sha256_file(draft)
    final_manifest = output / (
        f"{component}-windows-x86_64-{version}-{manifest_digest[:16]}.manifest.json"
    )
    draft.replace(final_manifest)
    return final_manifest, {
        "component": component, "version": version,
        "pythonRelativePath": "runtime/python.exe", "modelRelativePath": None,
        "alignerRelativePath": None, "unpackedSizeBytes": manifest["unpackedSizeBytes"],
        "sources": [source],
        "manifest": {
            "asset": final_manifest.name,
            "urls": [POOL + final_manifest.name],
            "sizeBytes": final_manifest.stat().st_size,
            "sha256": manifest_digest,
        },
    }


def build(lock_path: Path, output: Path, cache: Path, version: str) -> None:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if (set(lock) != {"schemaVersion", "reviewedAt", "platform", "python", "packages", "runtimes"}
            or lock["schemaVersion"] != 1 or lock["platform"] != "windows-x86_64"):
        raise SystemExit("provider runtime lock schema is invalid")
    packages = {}
    for package in lock["packages"]:
        identity = package_id(package.get("name", ""))
        if set(package) != REQUIRED_KEYS or identity in packages:
            raise SystemExit("provider runtime package lock is invalid")
        packages[identity] = package
    if set(lock["runtimes"]) != {"edge-tts", "gtts", "gemini-tts"}:
        raise SystemExit("provider runtime set is invalid")
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    validate_upstream(lock["python"], python=True)
    python_archive = fetch(lock["python"], cache)
    wheels = {}
    for name, package in packages.items():
        validate_upstream(package, python=False)
        wheels[name] = fetch(package, cache)
    summaries = []
    with tempfile.TemporaryDirectory(prefix="osg-provider-runtime-") as temporary:
        temporary_root = Path(temporary)
        for component, package_names in lock["runtimes"].items():
            if not package_names or len(package_names) != len(set(package_names)):
                raise SystemExit("provider runtime package selection is invalid")
            runtime_root = temporary_root / component
            python_root = extract_python(python_archive, runtime_root)
            prune_python(python_root, lock["python"]["prunedPaths"])
            site_packages = python_root / "Lib/site-packages"
            for name in package_names:
                identity = package_id(name)
                if identity != name or identity not in wheels:
                    raise SystemExit(f"provider runtime references an unknown package: {name}")
                extract_wheel(wheels[identity], site_packages, packages[identity])
            validate_notices(site_packages, len(package_names))
            notice = (json.dumps({
                "schemaVersion": 1,
                "component": component,
                "python": {
                    key: lock["python"][key]
                    for key in ("version", "release", "asset", "sizeBytes", "sha256", "sourceUrl", "license")
                },
                "packages": [packages[package_id(name)] for name in package_names],
            }, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
            manifest, summary = write_runtime(
                python_root, output, component, version, notice
            )
            summaries.append(summary)
            print(manifest)
    summary = output / "provider-runtime-releases.json"
    summary.write_text(
        json.dumps(summaries, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8", newline="\n",
    )
    print(summary)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--version", default="2026.08.12")
    args = parser.parse_args()
    build(args.lock, args.output, args.cache, args.version)


if __name__ == "__main__":
    main()
