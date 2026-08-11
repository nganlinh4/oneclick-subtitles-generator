"""Enforce one remote, content-addressed runtime contract for debug and release hosts.

The host never consumes authoring outputs directly. Package authors build locally, upload unique
assets, read the GitHub release back, then refresh the tracked checkpoint with ``--write``. Normal
checks compare current package-producing sources and catalogs with that checkpoint. ``--remote``
also proves every OSG pool asset still has the exact server-reported size and SHA-256 digest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
CHECKPOINT = ROOT / "delivery/managed-delivery.checkpoint.json"
POOL_PREFIX = (
    "https://github.com/nganlinh4/oneclick-subtitles-generator/"
    "releases/download/osg-runtime-bundles-v1/"
)
RELEASE_API = (
    "https://api.github.com/repos/nganlinh4/oneclick-subtitles-generator/"
    "releases/tags/osg-runtime-bundles-v1"
)

CATALOGS = {
    "nativeTools": Path("crates/osg-native-tools/delivery/native-tools.delivery.json"),
    "asr": Path("crates/osg-engine-packages/delivery/engine-packages.delivery.json"),
    "speech": Path("crates/osg-speech/delivery/speech-packages.delivery.json"),
    "remotion": Path("video-renderer/delivery/remotion-runtime.delivery.json"),
    "voiceSamples": Path("crates/osg-engine-packages/delivery/voice-samples.delivery.json"),
    "uiFonts": Path("crates/osg-engine-packages/delivery/ui-fonts.delivery.json"),
}

SOURCE_GROUPS = {
    "managedPython": [
        Path("scripts/build-managed-runtime-delivery.py"),
        Path("scripts/compose-managed-deliveries.py"),
        Path("crates/osg-engine-packages/delivery/windows-managed-runtime-notices.json"),
        Path("crates/osg-speech/delivery/speech-upstreams.lock.json"),
    ],
    "nativeTools": [
        Path("crates/osg-native-tools/delivery/native-tools.upstreams.lock.json"),
    ],
    "remotion": [
        Path("scripts/generate-remotion-delivery-manifest.mjs"),
        Path("scripts/generate-remotion-runtime-manifest.mjs"),
        Path("video-renderer/native.tsconfig.json"),
        Path("video-renderer/package.json"),
        Path("video-renderer/remotion.config.ts"),
        Path("video-renderer/scripts/build-native-bundle.mjs"),
        Path("video-renderer/worker/osg_render_worker.mjs"),
    ],
    "voiceSamples": [
        Path("scripts/build-voice-samples-delivery.py"),
    ],
    "uiFonts": [
        Path("scripts/build-ui-font-delivery.py"),
    ],
}

HOST_FORBIDDEN = (
    "development_root",
    "resolve_legacy_paths",
    "resolve_development_runtime",
    "local-runtime-bundles",
    ".allow_system_path(true)",
    ".bundled_root(",
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def canonical_source_bytes(value: bytes) -> bytes:
    """Make tracked text fingerprints independent of Git's checkout line-ending policy."""
    return value.replace(b"\r\n", b"\n")


def source_files(group: str) -> list[Path]:
    files = list(SOURCE_GROUPS[group])
    if group == "remotion":
        files.extend(
            path.relative_to(ROOT)
            for path in sorted((ROOT / "video-renderer/src").rglob("*"))
            if path.is_file() and path.suffix.lower() in {".ts", ".tsx", ".js", ".jsx", ".json"}
        )
    if not files or len(files) != len(set(files)):
        raise SystemExit(f"invalid managed-delivery source group: {group}")
    return sorted(files, key=lambda path: path.as_posix())


def source_digest(group: str) -> tuple[str, list[dict[str, object]]]:
    records = []
    aggregate = hashlib.sha256()
    for relative in source_files(group):
        path = ROOT / relative
        if not path.is_file():
            raise SystemExit(f"managed-delivery source is missing: {relative.as_posix()}")
        data = canonical_source_bytes(path.read_bytes())
        digest = sha256_bytes(data)
        record = {"path": relative.as_posix(), "sizeBytes": len(data), "sha256": digest}
        records.append(record)
        aggregate.update(canonical_json(record))
        aggregate.update(b"\n")
    return aggregate.hexdigest(), records


def read_catalogs() -> dict[str, object]:
    catalogs = {}
    for name, relative in CATALOGS.items():
        try:
            catalogs[name] = json.loads((ROOT / relative).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"managed-delivery catalog is invalid: {relative}: {error}") from error
    return catalogs


def delivery_value(group: str, catalogs: dict[str, object]) -> object:
    if group == "managedPython":
        return {"asr": catalogs["asr"], "speech": catalogs["speech"]}
    if group == "nativeTools":
        return catalogs["nativeTools"]
    if group == "remotion":
        return catalogs["remotion"]
    if group == "voiceSamples":
        return catalogs["voiceSamples"]
    if group == "uiFonts":
        return catalogs["uiFonts"]
    raise AssertionError(group)


def managed_release_assets(catalog: dict) -> list[dict]:
    assets = []
    for platform in catalog.get("platforms", {}).values():
        entries = platform.get("engines", platform.get("backends"))
        if entries is None:
            entries = [{"releases": platform.get("releases", [])}]
        for entry in entries:
            for release in entry.get("releases", []):
                if "manifest" in release:
                    assets.extend([release["manifest"], *release.get("sources", [])])
                else:
                    assets.append({
                        "asset": release["asset"],
                        "sizeBytes": release["sizeBytes"],
                        "sha256": release["sha256"],
                        "urls": [release["sourceUrl"]],
                    })
    return assets


def pool_assets(catalogs: dict[str, object]) -> list[dict[str, object]]:
    by_name: dict[str, dict[str, object]] = {}
    for name in ("asr", "speech", "remotion", "voiceSamples", "uiFonts"):
        for asset in managed_release_assets(catalogs[name]):
            urls = asset.get("urls", [])
            if not any(url.startswith(POOL_PREFIX) for url in urls):
                continue
            record = {
                "asset": asset["asset"],
                "sizeBytes": asset["sizeBytes"],
                "sha256": asset["sha256"],
            }
            previous = by_name.setdefault(record["asset"], record)
            if previous != record:
                raise SystemExit(f"conflicting pool asset identity: {record['asset']}")
            expected_url = POOL_PREFIX + str(record["asset"])
            if expected_url not in urls:
                raise SystemExit(f"pool asset does not use its exact content address: {record['asset']}")
    if not by_name:
        raise SystemExit("managed-delivery catalogs contain no OSG pool assets")
    return [by_name[name] for name in sorted(by_name)]


def assert_host_policy() -> None:
    host_root = ROOT / "apps/desktop/src-tauri/src"
    for path in sorted(host_root.rglob("*.rs")):
        source = path.read_text(encoding="utf-8")
        for token in HOST_FORBIDDEN:
            if token in source:
                raise SystemExit(
                    "desktop runtime may not bypass managed delivery with "
                    f"{token!r}: {path.relative_to(ROOT)}"
                )


def build_checkpoint() -> dict[str, object]:
    catalogs = read_catalogs()
    groups = {}
    for name in sorted(SOURCE_GROUPS):
        digest, files = source_digest(name)
        groups[name] = {
            "sourceSha256": digest,
            "deliverySha256": sha256_bytes(canonical_json(delivery_value(name, catalogs))),
            "sources": files,
        }
    return {
        "schemaVersion": 1,
        "pool": {
            "repository": "nganlinh4/oneclick-subtitles-generator",
            "tag": "osg-runtime-bundles-v1",
            "appendOnly": True,
        },
        "groups": groups,
        "remotePoolAssets": pool_assets(catalogs),
    }


def fetch_release() -> dict:
    request = Request(RELEASE_API, headers={"User-Agent": "OSG-delivery-checkpoint/1"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def verify_remote(expected: dict[str, object]) -> None:
    release = fetch_release()
    if release.get("tag_name") != expected["pool"]["tag"]:
        raise SystemExit("GitHub returned the wrong managed-delivery release")
    if release.get("draft") is not False or release.get("prerelease") is not False:
        raise SystemExit("managed-delivery pool must be a published non-prerelease release")
    remote = {asset["name"]: asset for asset in release.get("assets", [])}
    for asset in expected["remotePoolAssets"]:
        actual = remote.get(asset["asset"])
        if actual is None:
            raise SystemExit(f"remote pool asset is missing: {asset['asset']}")
        if actual.get("size") != asset["sizeBytes"]:
            raise SystemExit(f"remote pool size mismatch: {asset['asset']}")
        if actual.get("digest") != f"sha256:{asset['sha256']}":
            raise SystemExit(f"remote pool digest mismatch: {asset['asset']}")
    verify_native_tool_sources(read_catalogs()["nativeTools"])


def verify_native_tool_sources(catalog: dict) -> None:
    """Prove direct-first native sources are reachable without downloading their large bodies."""
    sources: dict[str, int] = {}
    for tool in catalog.get("tools", []):
        for notice in tool.get("notices", []):
            sources[notice["sourceUrl"]] = notice["sizeBytes"]
        for platform in tool.get("platforms", {}).values():
            for release in platform.get("releases", []):
                artifact = release["artifact"]
                sources[artifact["sourceUrl"]] = artifact["sizeBytes"]
    if not sources:
        raise SystemExit("native-tool catalog contains no direct sources")
    for url, size_bytes in sorted(sources.items()):
        request = Request(
            url,
            method="HEAD",
            headers={"User-Agent": "OSG-delivery-checkpoint/1"},
        )
        with urlopen(request, timeout=60) as response:
            if response.status != 200:
                raise SystemExit(f"native-tool source is unavailable: {url}")
            content_length = response.headers.get("Content-Length")
            if content_length is None or int(content_length) != size_bytes:
                raise SystemExit(f"native-tool source size mismatch: {url}")


def read_checkpoint() -> dict:
    try:
        return json.loads(CHECKPOINT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"managed-delivery checkpoint is missing or invalid: {error}") from error


def assert_changed_sources_have_new_delivery(previous: dict, current: dict) -> None:
    for name, group in current["groups"].items():
        old = previous.get("groups", {}).get(name)
        if not old:
            continue
        if (old.get("sourceSha256") != group["sourceSha256"]
                and old.get("deliverySha256") == group["deliverySha256"]):
            raise SystemExit(
                f"{name} package sources changed without a new content-addressed delivery; "
                "build, upload, read back, and update the catalog first"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote", action="store_true", help="verify GitHub release read-back")
    parser.add_argument("--write", action="store_true", help="refresh checkpoint after upload")
    args = parser.parse_args()

    assert_host_policy()
    current = build_checkpoint()
    if args.write:
        previous = read_checkpoint() if CHECKPOINT.exists() else {"groups": {}}
        assert_changed_sources_have_new_delivery(previous, current)
        verify_remote(current)
        CHECKPOINT.parent.mkdir(parents=True, exist_ok=True)
        CHECKPOINT.write_text(
            json.dumps(current, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        print(f"updated managed-delivery checkpoint: {CHECKPOINT.relative_to(ROOT)}")
        return

    tracked = read_checkpoint()
    if tracked != current:
        raise SystemExit(
            "managed-delivery checkpoint is stale; package authors must publish and read back "
            "new content-addressed assets before running with --write"
        )
    if args.remote:
        verify_remote(current)
    print(
        f"managed-delivery contract verified: {len(current['remotePoolAssets'])} pool assets, "
        f"{len(current['groups'])} source groups"
    )


if __name__ == "__main__":
    main()
