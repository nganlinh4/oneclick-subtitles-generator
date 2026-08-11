"""Build the reviewed Google Sans Flex managed UI-font delivery.

The font bytes are fetched from the exact Google Fonts v22 URLs first at
runtime. This authoring script mirrors those same bytes into the append-only
OSG development pool so the catalog has a byte-identical fallback. Nothing
from the authoring directory is consumed by the desktop application.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.request
from pathlib import Path


VERSION = "v22-ui4"
CSS_URL = (
    "https://fonts.googleapis.com/css2?family=Google+Sans+Flex:"
    "opsz,wght,GRAD,ROND@6..144,1..1000,0..100,0..100&display=swap"
)
CSS_SIZE = 6_747
CSS_SHA256 = "143a2f669a966fdfdcda6f972b49e504c5cf733924f459a86f500f16dff09707"
OFL_URL = "https://openfontlicense.org/documents/OFL.txt"
OFL_SIZE = 4_599
OFL_SHA256 = "1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e"
POOL_BASE = (
    "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/"
    "osg-runtime-bundles-v1/"
)
PLATFORMS = (
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
    "windows-x86_64",
)
EXPECTED_SUBSETS = {
    "vietnamese": {
        "size": 57_620,
        "sha256": "7343aefa9061998bdfea8c1e2aa6943a029218dd78a23e5fde441e832fe66629",
        "url": "https://fonts.gstatic.com/s/googlesansflex/v22/t5tFIQcYNIWbFgDgAAzZ34auoVyXkJCOjsOqNGFbN5hF8Ju1x4d-JwN2l9sIKwkaN7T3Qec.woff2",
    },
    "latin-ext": {
        "size": 131_208,
        "sha256": "0f63b3ae4c60341fc1348749796505e9ab621a3ab690b80f9cdf66dafc1eca19",
        "url": "https://fonts.gstatic.com/s/googlesansflex/v22/t5tFIQcYNIWbFgDgAAzZ34auoVyXkJCOjsOqNGFbN5hF8Ju1x4d-JwN2l9sIKwkaNrT3Qec.woff2",
    },
    "latin": {
        "size": 270_324,
        "sha256": "3215351d7b5587396710ab80bd31994ebbf3a9ee6f8e67b3c29a30d909cec55f",
        "url": "https://fonts.gstatic.com/s/googlesansflex/v22/t5tFIQcYNIWbFgDgAAzZ34auoVyXkJCOjsOqNGFbN5hF8Ju1x4d-JwN2l9sIKwkaOLT3.woff2",
    },
}
NOTICE = """Google Sans Flex managed UI font

Copyright 2015 Google LLC. All Rights Reserved.

Google Sans Flex has been published by Google Fonts under the SIL Open Font
License, Version 1.1. The installed WOFF2 files are byte-identical subsets
served by the official Google Fonts CSS API; OSG's pool copies are fallback
mirrors only.

Official family: https://fonts.google.com/specimen/Google+Sans+Flex
Official license FAQ: https://fonts.google.com/faq
Official CSS request: {css_url}
""".format(css_url=CSS_URL)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 Chrome/140 Safari/537.36"
            )
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def checked(data: bytes, *, size: int, sha256: str, label: str) -> bytes:
    if len(data) != size or digest(data) != sha256:
        raise SystemExit(f"{label} no longer matches its reviewed byte identity")
    return data


def pool_url(asset: str) -> str:
    return f"{POOL_BASE}{asset}"


def mirror_asset(prefix: str, data: bytes, extension: str) -> str:
    return f"{prefix}-{digest(data)[:16]}.{extension}"


def raw_source(asset: str, data: bytes, urls: list[str]) -> dict[str, object]:
    return {
        "asset": asset,
        "urls": urls,
        "sizeBytes": len(data),
        "sha256": digest(data),
        "kind": "raw",
    }


def build(output_dir: Path) -> tuple[dict[str, object], list[str]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    css_data = checked(
        fetch(CSS_URL), size=CSS_SIZE, sha256=CSS_SHA256, label="Google Fonts CSS"
    )
    css_text = css_data.decode("utf-8")
    blocks = {
        subset.strip(): block
        for subset, block in re.findall(
            r"/\* ([^*]+) \*/\s*(@font-face \{.*?\})",
            css_text,
            flags=re.DOTALL,
        )
    }
    if not set(EXPECTED_SUBSETS).issubset(blocks):
        raise SystemExit("Google Fonts CSS no longer contains the reviewed UI subsets")

    sources: list[dict[str, object]] = []
    files: list[dict[str, object]] = []
    emitted: list[str] = []
    local_blocks: list[str] = ["/* Generated from the reviewed Google Fonts v22 CSS API. */"]
    for source_index, (subset, expected) in enumerate(EXPECTED_SUBSETS.items()):
        block = blocks[subset]
        observed_url = re.search(r"url\((https://[^)]+)\)", block)
        if observed_url is None or observed_url.group(1) != expected["url"]:
            raise SystemExit(f"official URL drifted for the {subset} subset")
        data = checked(
            fetch(str(expected["url"])),
            size=int(expected["size"]),
            sha256=str(expected["sha256"]),
            label=f"Google Sans Flex {subset}",
        )
        asset = mirror_asset(f"google-sans-flex-{VERSION}-{subset}", data, "woff2")
        (output_dir / asset).write_bytes(data)
        emitted.append(asset)
        sources.append(raw_source(asset, data, [str(expected["url"]), pool_url(asset)]))
        relative_path = f"runtime/google-sans-flex-{subset}.woff2"
        files.append({
            "path": relative_path,
            "sizeBytes": len(data),
            "sha256": digest(data),
            "executable": False,
            "role": "runtime",
            "sourceIndex": source_index,
            "archivePath": None,
        })
        token = f"__OSG_FONT_{subset.upper().replace('-', '_')}__"
        local_block = block.replace("font-family: 'Google Sans Flex'", "font-family: 'Google Sans'")
        local_block = re.sub(r"url\(https://[^)]+\)", f'url("{token}")', local_block)
        local_blocks.append(f"/* {subset} */\n{local_block}")

    managed_css = ("\n".join(local_blocks) + "\n").encode("utf-8")
    css_asset = mirror_asset(f"google-sans-flex-{VERSION}", managed_css, "css")
    (output_dir / css_asset).write_bytes(managed_css)
    emitted.append(css_asset)
    css_source_index = len(sources)
    sources.append(raw_source(css_asset, managed_css, [pool_url(css_asset)]))
    files.append({
        "path": "runtime/google-sans-flex.css",
        "sizeBytes": len(managed_css),
        "sha256": digest(managed_css),
        "executable": False,
        "role": "runtime",
        "sourceIndex": css_source_index,
        "archivePath": None,
    })

    ofl_data = checked(fetch(OFL_URL), size=OFL_SIZE, sha256=OFL_SHA256, label="SIL OFL 1.1")
    ofl_asset = mirror_asset("sil-open-font-license-1.1", ofl_data, "txt")
    (output_dir / ofl_asset).write_bytes(ofl_data)
    emitted.append(ofl_asset)
    ofl_source_index = len(sources)
    sources.append(raw_source(ofl_asset, ofl_data, [OFL_URL, pool_url(ofl_asset)]))
    files.append({
        "path": "licenses/OFL.txt",
        "sizeBytes": len(ofl_data),
        "sha256": digest(ofl_data),
        "executable": False,
        "role": "license",
        "sourceIndex": ofl_source_index,
        "archivePath": None,
    })

    notice_data = NOTICE.encode("utf-8")
    notice_asset = mirror_asset("google-sans-flex-NOTICE", notice_data, "txt")
    (output_dir / notice_asset).write_bytes(notice_data)
    emitted.append(notice_asset)
    notice_source_index = len(sources)
    sources.append(raw_source(notice_asset, notice_data, [pool_url(notice_asset)]))
    files.append({
        "path": "licenses/NOTICE.txt",
        "sizeBytes": len(notice_data),
        "sha256": digest(notice_data),
        "executable": False,
        "role": "license",
        "sourceIndex": notice_source_index,
        "archivePath": None,
    })

    manifest = {
        "schemaVersion": 1,
        "component": "google-sans-flex",
        "platform": "all",
        "version": VERSION,
        "pythonRelativePath": "runtime/google-sans-flex.css",
        "modelRelativePath": None,
        "alignerRelativePath": None,
        "unpackedSizeBytes": sum(int(file["sizeBytes"]) for file in files),
        "files": files,
    }
    manifest_data = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    manifest_asset = mirror_asset(f"google-sans-flex-{VERSION}", manifest_data, "delivery.json")
    (output_dir / manifest_asset).write_bytes(manifest_data)
    emitted.append(manifest_asset)
    manifest_record = {
        "asset": manifest_asset,
        "urls": [pool_url(manifest_asset)],
        "sizeBytes": len(manifest_data),
        "sha256": digest(manifest_data),
    }
    release = {
        "version": VERSION,
        "asset": manifest_asset,
        "sourceUrl": "",
        "sizeBytes": len(manifest_data) + sum(int(source["sizeBytes"]) for source in sources),
        "sha256": digest(manifest_data),
        "unpackedSizeBytes": manifest["unpackedSizeBytes"],
        "primaryRelativePath": manifest["pythonRelativePath"],
        "sources": sources,
        "manifest": manifest_record,
    }
    catalog = {
        "schemaVersion": 1,
        "family": "Google Sans Flex",
        "license": "OFL-1.1",
        "cssApiUrl": CSS_URL,
        "cssSha256": CSS_SHA256,
        "platforms": {platform: {"releases": [release]} for platform in PLATFORMS},
    }
    report = {
        "version": VERSION,
        "assets": emitted,
        "downloadSizeBytes": release["sizeBytes"],
        "installedSizeBytes": release["unpackedSizeBytes"],
        "manifest": manifest_record,
    }
    (output_dir / "ui-fonts.build.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return catalog, emitted


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--catalog-output", type=Path)
    args = parser.parse_args()
    catalog, assets = build(args.output_dir.resolve())
    if args.catalog_output:
        args.catalog_output.write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps({"assets": assets, "catalog": catalog}, ensure_ascii=False))


if __name__ == "__main__":
    main()
