"""Enforce one remote, content-addressed runtime contract for debug and release hosts.

The host never consumes authoring outputs directly. Package authors build locally, upload unique
assets, read the GitHub release back, then refresh the tracked checkpoint with ``--write``. Normal
checks compare current package-producing sources and catalogs with that checkpoint. ``--remote``
also proves every OSG pool asset still has the exact server-reported size and SHA-256 digest.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import ssl
import time
from pathlib import Path
from typing import Callable, NamedTuple, TypeVar
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


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
        Path("scripts/build-provider-speech-runtime.py"),
        Path("scripts/apply-managed-delivery-catalog.py"),
        Path("scripts/compose-managed-deliveries.py"),
        Path("crates/osg-engine-packages/delivery/windows-managed-runtime-notices.json"),
        Path("crates/osg-speech/delivery/speech-upstreams.lock.json"),
        Path("crates/osg-speech/delivery/provider-runtime-windows.lock.json"),
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

REMOTE_RETRY_DELAYS_SECONDS = (1, 2, 4, 8)
REMOTE_ATTEMPT_TIMEOUT_SECONDS = 20
REMOTE_VERIFICATION_BUDGET_SECONDS = 300
RELEASE_METADATA_LIMIT_BYTES = 2 * 1024 * 1024
RELEASE_METADATA_READ_CHUNK_BYTES = 64 * 1024
TRANSIENT_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})
REMOTE_SOURCES = frozenset({"release-api", "native-tool-source"})
SAFE_REMOTE_HOST = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
SAFE_TOOL_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
SAFE_ERROR_CLASS = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
T = TypeVar("T")


class RemoteAttribution(NamedTuple):
    source: str
    host: str
    tool_id: str


class RemoteResponseFailure(Exception):
    def __init__(self, *, status: int | None, error_class: str, retryable: bool) -> None:
        super().__init__(error_class)
        self.status = status
        self.error_class = error_class
        self.retryable = retryable


class ReviewedRedirectHandler(HTTPRedirectHandler):
    """Keep metadata probes body-free and credentials on their original HTTPS origin."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        redirected = super().redirect_request(
            request,
            response,
            code,
            message,
            headers,
            new_url,
        )
        if redirected is None:
            return None
        try:
            original_url = urlsplit(request.full_url)
            redirected_url = urlsplit(redirected.full_url)
            original_host = (original_url.hostname or "").encode("idna").decode("ascii").lower()
            redirected_host = (
                (redirected_url.hostname or "").encode("idna").decode("ascii").lower()
            )
            original_port = original_url.port if original_url.port is not None else 443
            redirected_port = redirected_url.port if redirected_url.port is not None else 443
        except (UnicodeError, ValueError):
            if response is not None:
                response.close()
            raise RemoteResponseFailure(
                status=code,
                error_class="invalid-redirect",
                retryable=False,
            ) from None
        if redirected_url.username is not None or redirected_url.password is not None:
            if response is not None:
                response.close()
            raise RemoteResponseFailure(
                status=code,
                error_class="credentialed-redirect",
                retryable=False,
            )
        if redirected_url.scheme != "https":
            if response is not None:
                response.close()
            raise RemoteResponseFailure(
                status=code,
                error_class="insecure-redirect",
                retryable=False,
            )
        same_origin = (
            original_url.scheme.lower() == "https"
            and redirected_url.scheme.lower() == "https"
            and original_host == redirected_host
            and original_port == redirected_port
        )
        if same_origin:
            redirected_headers = dict(redirected.header_items())
        else:
            sensitive_headers = frozenset({"authorization", "cookie", "proxy-authorization"})
            redirected_headers = {
                name: value
                for name, value in redirected.header_items()
                if name.lower() not in sensitive_headers and name.lower() == "user-agent"
            }
        return Request(
            redirected.full_url,
            headers=redirected_headers,
            origin_req_host=request.origin_req_host,
            unverifiable=True,
            method="HEAD" if request.get_method() == "HEAD" else redirected.get_method(),
        )


REMOTE_OPENER = build_opener(ReviewedRedirectHandler())


def urlopen(request: Request, *, timeout: float):
    return REMOTE_OPENER.open(request, timeout=timeout)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def remote_attribution(
    request: Request,
    *,
    source: str,
    tool_id: str | None = None,
) -> RemoteAttribution:
    """Reduce a reviewed request to fields that are safe for CI diagnostics."""
    if source not in REMOTE_SOURCES:
        raise SystemExit("managed-delivery remote attribution has an invalid source class")
    try:
        parsed = urlsplit(request.full_url)
        host = (parsed.hostname or "").encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError):
        raise SystemExit("managed-delivery remote attribution has an invalid HTTPS host") from None
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or not SAFE_REMOTE_HOST.fullmatch(host)
    ):
        raise SystemExit("managed-delivery remote attribution has an invalid HTTPS host")
    safe_tool_id = tool_id if tool_id is not None else "none"
    if safe_tool_id != "none" and not SAFE_TOOL_ID.fullmatch(safe_tool_id):
        raise SystemExit("managed-delivery remote attribution has an invalid tool ID")
    return RemoteAttribution(source=source, host=host, tool_id=safe_tool_id)


def remote_status(response) -> int | None:
    status = getattr(response, "status", None)
    if status is None and hasattr(response, "getcode"):
        status = response.getcode()
    return status if isinstance(status, int) and 100 <= status <= 599 else None


def raise_remote_failure(
    attribution: RemoteAttribution,
    *,
    status: int | None,
    error_class: str,
) -> None:
    if not SAFE_ERROR_CLASS.fullmatch(error_class):
        error_class = "internal-classification"
    safe_status = str(status) if isinstance(status, int) and 100 <= status <= 599 else "none"
    raise SystemExit(
        "managed-delivery remote verification failed: "
        f"source={attribution.source} host={attribution.host} "
        f"tool={attribution.tool_id} status={safe_status} errorClass={error_class}"
    ) from None


def classify_transport_failure(error: BaseException) -> str:
    if isinstance(error, http.client.IncompleteRead):
        return "incomplete-read"
    reason = error.reason if isinstance(error, URLError) else error
    if isinstance(reason, ssl.SSLError):
        return "tls"
    if isinstance(reason, TimeoutError):
        return "timeout"
    if isinstance(reason, ConnectionError):
        return "connection"
    if isinstance(reason, http.client.HTTPException):
        return "http-protocol"
    if isinstance(reason, OSError):
        return "io"
    return "transport"


def read_bounded_remote_body(
    response,
    *,
    status: int | None,
    byte_limit: int,
    deadline: float,
) -> bytes:
    """Read bounded release metadata in chunks while enforcing the shared deadline."""
    chunks: list[bytes] = []
    total = 0
    while True:
        if time.monotonic() >= deadline:
            raise RemoteResponseFailure(
                status=status,
                error_class="budget-exhausted",
                retryable=False,
            )
        read_size = min(RELEASE_METADATA_READ_CHUNK_BYTES, byte_limit + 1 - total)
        chunk = response.read(read_size)
        if not isinstance(chunk, bytes):
            raise RemoteResponseFailure(
                status=status,
                error_class="invalid-response-body",
                retryable=False,
            )
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > byte_limit:
            raise RemoteResponseFailure(
                status=status,
                error_class="response-too-large",
                retryable=False,
            )
    return b"".join(chunks)


def perform_remote_request(
    request: Request,
    *,
    timeout: int,
    source: str,
    consume: Callable[[object], T],
    tool_id: str | None = None,
    deadline: float | None = None,
) -> T:
    """Perform and consume one reviewed request with a shared, bounded retry budget."""
    attribution = remote_attribution(request, source=source, tool_id=tool_id)
    if timeout <= 0:
        raise SystemExit("managed-delivery remote timeout must be positive")
    effective_deadline = (
        deadline
        if deadline is not None
        else time.monotonic() + REMOTE_VERIFICATION_BUDGET_SECONDS
    )
    attempts = len(REMOTE_RETRY_DELAYS_SECONDS) + 1
    for attempt in range(attempts):
        remaining = effective_deadline - time.monotonic()
        if remaining <= 0:
            raise_remote_failure(
                attribution,
                status=None,
                error_class="budget-exhausted",
            )
        attempt_timeout = min(float(timeout), REMOTE_ATTEMPT_TIMEOUT_SECONDS, remaining)
        failure_status = None
        failure_class = "transport"
        retryable = True
        try:
            with urlopen(request, timeout=attempt_timeout) as response:
                result = consume(response)
                if time.monotonic() >= effective_deadline:
                    raise RemoteResponseFailure(
                        status=remote_status(response),
                        error_class="budget-exhausted",
                        retryable=False,
                    )
                return result
        except HTTPError as error:
            failure_status = error.code
            failure_class = (
                "http-transient"
                if error.code in TRANSIENT_HTTP_STATUSES
                else "http-permanent"
            )
            retryable = error.code in TRANSIENT_HTTP_STATUSES
            error.close()
        except RemoteResponseFailure as error:
            failure_status = error.status
            failure_class = error.error_class
            retryable = error.retryable
        except (
            URLError,
            TimeoutError,
            ConnectionError,
            http.client.HTTPException,
            ssl.SSLError,
            OSError,
        ) as error:
            failure_class = classify_transport_failure(error)

        if not retryable or attempt + 1 == attempts:
            raise_remote_failure(
                attribution,
                status=failure_status,
                error_class=failure_class,
            )
        delay = REMOTE_RETRY_DELAYS_SECONDS[attempt]
        if time.monotonic() + delay >= effective_deadline:
            raise_remote_failure(
                attribution,
                status=failure_status,
                error_class="budget-exhausted",
            )
        time.sleep(delay)

    raise AssertionError("bounded remote retry loop exhausted without returning or raising")


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


def fetch_release(*, deadline: float | None = None) -> dict:
    headers = {"User-Agent": "OSG-delivery-checkpoint/1"}
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(RELEASE_API, headers=headers)
    effective_deadline = (
        deadline
        if deadline is not None
        else time.monotonic() + REMOTE_VERIFICATION_BUDGET_SECONDS
    )

    def consume(response) -> dict:
        status = remote_status(response)
        if status != 200:
            raise RemoteResponseFailure(
                status=status,
                error_class="unexpected-status",
                retryable=status in TRANSIENT_HTTP_STATUSES,
            )
        content_length = response.headers.get("Content-Length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except (TypeError, ValueError):
                raise RemoteResponseFailure(
                    status=status,
                    error_class="invalid-content-length",
                    retryable=True,
                ) from None
            if declared_length < 0 or declared_length > RELEASE_METADATA_LIMIT_BYTES:
                raise RemoteResponseFailure(
                    status=status,
                    error_class="response-too-large",
                    retryable=False,
                )
        body = read_bounded_remote_body(
            response,
            status=status,
            byte_limit=RELEASE_METADATA_LIMIT_BYTES,
            deadline=effective_deadline,
        )
        if content_length is not None and len(body) != declared_length:
            raise RemoteResponseFailure(
                status=status,
                error_class="incomplete-read",
                retryable=True,
            )
        try:
            release = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RemoteResponseFailure(
                status=status,
                error_class="invalid-json",
                retryable=True,
            ) from None
        if not isinstance(release, dict):
            raise RemoteResponseFailure(
                status=status,
                error_class="invalid-schema",
                retryable=False,
            )
        return release

    return perform_remote_request(
        request,
        timeout=30,
        source="release-api",
        consume=consume,
        deadline=effective_deadline,
    )


def verify_remote(expected: dict[str, object]) -> None:
    deadline = time.monotonic() + REMOTE_VERIFICATION_BUDGET_SECONDS
    release_attribution = remote_attribution(Request(RELEASE_API), source="release-api")
    release = fetch_release(deadline=deadline)
    if release.get("tag_name") != expected["pool"]["tag"]:
        raise_remote_failure(
            release_attribution,
            status=200,
            error_class="tag-mismatch",
        )
    if release.get("draft") is not False or release.get("prerelease") is not False:
        raise_remote_failure(
            release_attribution,
            status=200,
            error_class="release-policy",
        )
    release_assets = release.get("assets")
    if not isinstance(release_assets, list) or any(
        not isinstance(asset, dict) or not isinstance(asset.get("name"), str)
        for asset in release_assets
    ):
        raise_remote_failure(
            release_attribution,
            status=200,
            error_class="invalid-schema",
        )
    remote = {}
    for asset in release_assets:
        if asset["name"] in remote:
            raise_remote_failure(
                release_attribution,
                status=200,
                error_class="duplicate-asset",
            )
        remote[asset["name"]] = asset
    for asset in expected["remotePoolAssets"]:
        actual = remote.get(asset["asset"])
        if actual is None:
            raise_remote_failure(
                release_attribution,
                status=200,
                error_class="asset-missing",
            )
        if actual.get("size") != asset["sizeBytes"]:
            raise_remote_failure(
                release_attribution,
                status=200,
                error_class="asset-size-mismatch",
            )
        if actual.get("digest") != f"sha256:{asset['sha256']}":
            raise_remote_failure(
                release_attribution,
                status=200,
                error_class="asset-digest-mismatch",
            )
    verify_native_tool_sources(read_catalogs()["nativeTools"], deadline=deadline)


def verify_native_tool_sources(catalog: dict, *, deadline: float | None = None) -> None:
    """Probe direct-first native-source metadata without downloading their large bodies."""
    sources: dict[str, tuple[int, str]] = {}
    for tool in catalog.get("tools", []):
        tool_id = tool.get("id")
        if not isinstance(tool_id, str) or not SAFE_TOOL_ID.fullmatch(tool_id):
            raise SystemExit("native-tool catalog contains an invalid tool ID")
        for notice in tool.get("notices", []):
            source = (notice["sizeBytes"], tool_id)
            previous = sources.setdefault(notice["sourceUrl"], source)
            if previous != source:
                raise SystemExit(f"native-tool catalog has a conflicting source for: {tool_id}")
        for platform in tool.get("platforms", {}).values():
            for release in platform.get("releases", []):
                artifact = release["artifact"]
                source = (artifact["sizeBytes"], tool_id)
                previous = sources.setdefault(artifact["sourceUrl"], source)
                if previous != source:
                    raise SystemExit(f"native-tool catalog has a conflicting source for: {tool_id}")
    if not sources:
        raise SystemExit("native-tool catalog contains no direct sources")
    effective_deadline = (
        deadline
        if deadline is not None
        else time.monotonic() + REMOTE_VERIFICATION_BUDGET_SECONDS
    )
    for url, (size_bytes, tool_id) in sorted(sources.items()):
        request = Request(
            url,
            method="HEAD",
            headers={"User-Agent": "OSG-delivery-checkpoint/1"},
        )

        def consume(response) -> None:
            status = remote_status(response)
            if status != 200:
                raise RemoteResponseFailure(
                    status=status,
                    error_class="unexpected-status",
                    retryable=status in TRANSIENT_HTTP_STATUSES,
                )
            content_length = response.headers.get("Content-Length")
            if content_length is None:
                raise RemoteResponseFailure(
                    status=status,
                    error_class="content-length-missing",
                    retryable=False,
                )
            try:
                actual_size = int(content_length)
            except (TypeError, ValueError):
                raise RemoteResponseFailure(
                    status=status,
                    error_class="invalid-content-length",
                    retryable=False,
                ) from None
            if actual_size != size_bytes:
                raise RemoteResponseFailure(
                    status=status,
                    error_class="size-mismatch",
                    retryable=False,
                )

        perform_remote_request(
            request,
            timeout=60,
            source="native-tool-source",
            tool_id=tool_id,
            consume=consume,
            deadline=effective_deadline,
        )


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
