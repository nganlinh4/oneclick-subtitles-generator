"""Compose per-engine manifests from verified runtime parts and official models."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import quote


POOL = (
    "https://github.com/nganlinh4/screen-goated-toolbox/"
    "releases/download/sgt-runtime-bundles/"
)

MODEL_SPECS = {
    "parakeet": {
        "repo": "istupakov/parakeet-tdt-0.6b-v3-onnx",
        "revision": "8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce",
        "root": "istupakov--parakeet-tdt-0.6b-v3-onnx",
        "license": "CC-BY-4.0",
    },
    "faster-whisper-turbo": {
        "repo": "dropbox-dash/faster-whisper-large-v3-turbo",
        "revision": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
        "root": "dropbox-dash--faster-whisper-large-v3-turbo",
        "license": "MIT",
    },
    "faster-whisper-large-v3": {
        "repo": "Systran/faster-whisper-large-v3",
        "revision": "edaa852ec7e145841d8ffdb056a99866b5f0a478",
        "root": "Systran--faster-whisper-large-v3",
        "license": "MIT",
    },
    "qwen3-asr-1.7b": {
        "repo": "Qwen/Qwen3-ASR-1.7B",
        "revision": "7278e1e70fe206f11671096ffdd38061171dd6e5",
        "root": "Qwen--Qwen3-ASR-1.7B",
        "license": "Apache-2.0",
        "aligner": "qwen-aligner",
    },
    "qwen3-asr-0.6b": {
        "repo": "Qwen/Qwen3-ASR-0.6B",
        "revision": "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
        "root": "Qwen--Qwen3-ASR-0.6B",
        "license": "Apache-2.0",
        "aligner": "qwen-aligner",
    },
    "qwen-aligner": {
        "repo": "Qwen/Qwen3-ForcedAligner-0.6B",
        "revision": "c7cbfc2048c462b0d63a45797104fc9db3ad62b7",
        "root": "Qwen--Qwen3-ForcedAligner-0.6B",
        "license": "Apache-2.0",
    },
    "f5-main": {
        "repo": "SWivid/F5-TTS",
        "revision": "84e5a410d9cead4de2f847e7c9369a6440bdfaca",
        "root": "SWivid--F5-TTS",
        "license": "CC-BY-NC-4.0",
        "files": [
            "F5TTS_v1_Base/model_1250000.safetensors",
            "F5TTS_v1_Base/vocab.txt",
        ],
    },
    "f5-vocos": {
        "repo": "charactr/vocos-mel-24khz",
        "revision": "0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21",
        "root": "charactr--vocos-mel-24khz",
        "license": "MIT",
        "files": ["config.yaml", "pytorch_model.bin"],
    },
    "chatterbox": {
        "repo": "ResembleAI/chatterbox",
        "revision": "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18",
        "root": "ResembleAI--chatterbox",
        "license": "MIT",
        "files": [
            "ve.safetensors",
            "t3_cfg.safetensors",
            "s3gen.safetensors",
            "tokenizer.json",
            "ve.pt",
            "t3_mtl23ls_v2.safetensors",
            "s3gen.pt",
            "grapheme_mtl_merged_expanded_v1.json",
            "Cangjie5_TC.json",
            "conds.pt",
        ],
    },
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def official_files(model_root: Path, name: str) -> list[tuple[Path, str, dict]]:
    spec = MODEL_SPECS[name]
    root = model_root / spec["root"]
    names = spec.get("files")
    if names is None:
        names = [
            path.relative_to(root).as_posix()
            for path in root.rglob("*")
            if path.is_file() and ".cache" not in path.relative_to(root).parts
        ]
    return [(root / relative, relative, spec) for relative in sorted(names)]


def add_official_model(
    manifest: dict,
    model_root: Path,
    spec_name: str,
    destination: str,
    role: str,
) -> None:
    for path, relative, spec in official_files(model_root, spec_name):
        if not path.is_file():
            raise SystemExit(f"missing pinned model file: {path}")
        asset = path.name
        source_index = len(manifest["sources"])
        manifest["sources"].append(
            {
                "kind": "raw",
                "asset": asset,
                "sizeBytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "urls": [
                    f"https://huggingface.co/{spec['repo']}/resolve/"
                    f"{spec['revision']}/{quote(relative, safe='/')}"
                ],
            }
        )
        manifest["files"].append(
            {
                "path": f"{destination}/{relative}",
                "sizeBytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "executable": False,
                "role": role,
                "sourceIndex": source_index,
                "archivePath": None,
            }
        )


def add_notice(manifest: dict, notice: Path) -> None:
    source_index = len(manifest["sources"])
    manifest["sources"].append(
        {
            "kind": "raw",
            "asset": notice.name,
            "sizeBytes": notice.stat().st_size,
            "sha256": sha256_file(notice),
            "urls": [POOL + notice.name],
        }
    )
    manifest["files"].append(
        {
            "path": "licenses/THIRD_PARTY_NOTICES.json",
            "sizeBytes": notice.stat().st_size,
            "sha256": sha256_file(notice),
            "executable": False,
            "role": "license",
            "sourceIndex": source_index,
            "archivePath": None,
        }
    )


def compose(
    runtime_manifest: Path,
    output: Path,
    model_root: Path,
    notice: Path,
    component: str,
    version: str,
    model_specs: list[tuple[str, str]],
    aligner_spec: str | None = None,
    canonical_sources: dict[str, dict] | None = None,
) -> tuple[Path, dict]:
    runtime = json.loads(runtime_manifest.read_text(encoding="utf-8"))
    if canonical_sources:
        runtime["sources"] = [
            canonical_sources.get(source["sha256"], source)
            for source in runtime["sources"]
        ]
    manifest = {
        "schemaVersion": 1,
        "component": component,
        "platform": "windows-x86_64",
        "version": version,
        "pythonRelativePath": "runtime/python.exe",
        "modelRelativePath": "model" if model_specs else None,
        "alignerRelativePath": "aligner" if aligner_spec else None,
        "unpackedSizeBytes": 0,
        "sources": runtime["sources"],
        "files": runtime["files"],
    }
    for spec_name, destination in model_specs:
        add_official_model(manifest, model_root, spec_name, destination, "model")
    if aligner_spec:
        add_official_model(manifest, model_root, aligner_spec, "aligner", "aligner")
    add_notice(manifest, notice)
    manifest["unpackedSizeBytes"] = sum(item["sizeBytes"] for item in manifest["files"])
    sources = manifest.pop("sources")
    encoded = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n"
    temporary = output / f"{component}-windows-x86_64-{version}.manifest.json"
    temporary.write_text(encoded, encoding="utf-8", newline="\n")
    digest = sha256_file(temporary)
    final = output / f"{component}-windows-x86_64-{version}-{digest[:16]}.manifest.json"
    temporary.replace(final)
    return final, {
        "component": component,
        "version": version,
        "pythonRelativePath": manifest["pythonRelativePath"],
        "modelRelativePath": manifest["modelRelativePath"],
        "alignerRelativePath": manifest["alignerRelativePath"],
        "unpackedSizeBytes": manifest["unpackedSizeBytes"],
        "sources": sources,
        "manifest": {
            "asset": final.name,
            "urls": [POOL + final.name],
            "sizeBytes": final.stat().st_size,
            "sha256": sha256_file(final),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asr-runtime-manifest", type=Path, required=True)
    parser.add_argument("--speech-runtime-manifest", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--notice", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", default="2026.08.10")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    asr_runtime = json.loads(args.asr_runtime_manifest.read_text(encoding="utf-8"))
    canonical_runtime_sources = {
        source["sha256"]: source for source in asr_runtime["sources"]
    }

    asr = {
        "parakeet": ([('parakeet', 'model')], None),
        "faster-whisper-turbo": ([('faster-whisper-turbo', 'model')], None),
        "faster-whisper-large-v3": ([('faster-whisper-large-v3', 'model')], None),
        "qwen3-asr-1.7b": ([('qwen3-asr-1.7b', 'model')], 'qwen-aligner'),
        "qwen3-asr-0.6b": ([('qwen3-asr-0.6b', 'model')], 'qwen-aligner'),
    }
    speech = {
        "f5-tts": [('f5-main', 'model'), ('f5-vocos', 'model/vocos')],
        "chatterbox": [('chatterbox', 'model')],
        "edge-tts": [],
        "gtts": [],
        "gemini-tts": [],
    }
    outputs = []
    releases = []
    for component, (models, aligner) in asr.items():
        output, release = compose(args.asr_runtime_manifest, args.output, args.model_root,
                                  args.notice, component, args.version, models, aligner)
        outputs.append(output)
        releases.append(release)
    for component, models in speech.items():
        output, release = compose(args.speech_runtime_manifest, args.output, args.model_root,
                                  args.notice, component, args.version, models,
                                  canonical_sources=canonical_runtime_sources)
        outputs.append(output)
        releases.append(release)
    summary = args.output / "managed-delivery-releases.json"
    summary.write_text(json.dumps(releases, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8", newline="\n")
    for output in outputs:
        print(output)
    print(summary)


if __name__ == "__main__":
    main()
