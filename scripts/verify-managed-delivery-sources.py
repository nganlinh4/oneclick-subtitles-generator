"""Verify pool digests and immutable external source reachability."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen


POOL_PREFIX = (
    "https://github.com/nganlinh4/screen-goated-toolbox/"
    "releases/download/sgt-runtime-bundles/"
)
RELEASE_API = (
    "https://api.github.com/repos/nganlinh4/screen-goated-toolbox/"
    "releases/tags/sgt-runtime-bundles"
)


def read_assets(catalogs: list[Path]) -> dict[tuple[str, str, tuple[str, ...]], dict]:
    assets = {}
    for path in catalogs:
        catalog = json.loads(path.read_text(encoding="utf-8"))
        platform = catalog["platforms"]["windows-x86_64"]
        entries = platform.get("engines", platform.get("backends"))
        if entries is None:
            entries = [{"releases": platform.get("releases", [])}]
        for entry in entries:
            for release in entry["releases"]:
                for asset in [release["manifest"], *release["sources"]]:
                    key = (asset["sha256"], asset["asset"], tuple(asset["urls"]))
                    assets.setdefault(key, asset)
    return assets


def fetch_json(url: str) -> dict:
    request = Request(url, headers={"User-Agent": "OSG-delivery-verifier/1"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def verify_pool(assets: dict[tuple[str, str, tuple[str, ...]], dict]) -> None:
    release = fetch_json(RELEASE_API)
    remote = {asset["name"]: asset for asset in release["assets"]}
    for asset in assets.values():
        for url in asset["urls"]:
            if not url.startswith(POOL_PREFIX):
                continue
            record = remote.get(asset["asset"])
            if record is None:
                raise SystemExit(f"pool asset is missing: {asset['asset']}")
            if record["size"] != asset["sizeBytes"]:
                raise SystemExit(f"pool size mismatch: {asset['asset']}")
            if record.get("digest") != f"sha256:{asset['sha256']}":
                raise SystemExit(f"pool digest mismatch: {asset['asset']}")


def verify_external(assets: dict[tuple[str, str, tuple[str, ...]], dict]) -> None:
    for asset in assets.values():
        for url in asset["urls"]:
            if url.startswith(POOL_PREFIX):
                continue
            request = Request(
                url,
                method="HEAD",
                headers={"User-Agent": "OSG-delivery-verifier/1"},
            )
            with urlopen(request, timeout=60) as response:
                if response.status != 200:
                    raise SystemExit(f"external source unavailable: {url}")
                length = response.headers.get("Content-Length")
                if length is not None and int(length) != asset["sizeBytes"]:
                    raise SystemExit(f"external source size mismatch: {url}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("catalog", type=Path, nargs="+")
    args = parser.parse_args()
    assets = read_assets(args.catalog)
    verify_pool(assets)
    verify_external(assets)
    print(f"verified {len(assets)} unique managed-delivery assets")


if __name__ == "__main__":
    main()
