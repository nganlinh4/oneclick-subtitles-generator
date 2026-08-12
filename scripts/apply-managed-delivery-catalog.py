"""Apply generated Windows delivery summaries to the checked-in catalogs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


POOL = (
    "https://github.com/nganlinh4/oneclick-subtitles-generator/"
    "releases/download/osg-runtime-bundles-v1/"
)
ASR = {
    "parakeet",
    "faster-whisper-turbo",
    "faster-whisper-large-v3",
    "qwen3-asr-1.7b",
    "qwen3-asr-0.6b",
}


def release_record(summary: dict, speech: bool) -> dict:
    manifest = summary["manifest"]
    record = {
        "version": summary["version"],
        "asset": manifest["asset"],
        "sizeBytes": manifest["sizeBytes"]
        + sum(source["sizeBytes"] for source in summary["sources"]),
        "sha256": manifest["sha256"],
        "unpackedSizeBytes": summary["unpackedSizeBytes"],
        "pythonRelativePath": summary["pythonRelativePath"],
        "modelRelativePath": summary["modelRelativePath"],
        "files": [],
        "sources": summary["sources"],
        "manifest": manifest,
    }
    if speech:
        record["sourceUrl"] = POOL + manifest["asset"]
    else:
        record["alignerRelativePath"] = summary["alignerRelativePath"]
    return record


def update_catalog(path: Path, releases: dict[str, dict], collection: str) -> None:
    catalog = json.loads(path.read_text(encoding="utf-8"))
    catalog["schemaVersion"] = 2
    entries = catalog["platforms"]["windows-x86_64"][collection]
    for entry in entries:
        if entry["id"] not in releases:
            continue
        summary = releases[entry["id"]]
        entry["releases"] = [release_record(summary, collection == "backends")]
    path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    summaries = parser.add_mutually_exclusive_group(required=True)
    summaries.add_argument("--summary", type=Path)
    summaries.add_argument("--provider-summary", type=Path)
    parser.add_argument("--asr-catalog", type=Path)
    parser.add_argument("--speech-catalog", type=Path, required=True)
    args = parser.parse_args()
    summary_path = args.summary or args.provider_summary
    summaries = {
        item["component"]: item
        for item in json.loads(summary_path.read_text(encoding="utf-8"))
    }
    providers = {"edge-tts", "gtts", "gemini-tts"}
    if args.provider_summary:
        if set(summaries) != providers or args.asr_catalog is not None:
            raise SystemExit("provider summary must contain the exact provider runtime set")
    else:
        if (set(summaries) != ASR | {"f5-tts", "chatterbox", *providers}
                or args.asr_catalog is None):
            raise SystemExit("delivery summary does not contain the exact managed component set")
        update_catalog(args.asr_catalog, summaries, "engines")
    update_catalog(args.speech_catalog, summaries, "backends")


if __name__ == "__main__":
    main()
