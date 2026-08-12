from __future__ import annotations

import importlib.util
import http.client
import ssl
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError


MODULE_PATH = Path(__file__).with_name("check-managed-delivery-contract.py")
SPEC = importlib.util.spec_from_file_location("managed_delivery_contract", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class Response:
    def __init__(self, body=b"", *, status=200, headers=None, forbid_read=False):
        self.body = body
        self.status = status
        self.headers = headers or {}
        self.forbid_read = forbid_read
        self.read_calls = []
        self.offset = 0

    def read(self, size=-1):
        if self.forbid_read:
            raise AssertionError("HEAD validation must not read a response body")
        self.read_calls.append(size)
        if size < 0:
            chunk = self.body[self.offset:]
            self.offset = len(self.body)
            return chunk
        chunk = self.body[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class ManagedDeliveryContractTests(unittest.TestCase):
    def test_release_readback_uses_available_github_token(self) -> None:
        captured = []

        def open_request(request, timeout):
            captured.append((request, timeout))
            return Response(b"{}", headers={"Content-Length": "2"})

        with mock.patch.dict(MODULE.os.environ, {"GITHUB_TOKEN": "test-token"}, clear=False):
            with mock.patch.object(MODULE, "urlopen", side_effect=open_request):
                MODULE.fetch_release()

        self.assertEqual(len(captured), 1)
        request, timeout = captured[0]
        self.assertEqual(timeout, MODULE.REMOTE_ATTEMPT_TIMEOUT_SECONDS)
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_redirects_preserve_head_and_strip_cross_host_authorization(self) -> None:
        request = MODULE.Request(
            "https://github.com/example/tool.zip?private=origin",
            method="HEAD",
            headers={
                "Authorization": "Bearer secret",
                "Cookie": "session=secret",
                "Proxy-Authorization": "Basic secret",
                "User-Agent": "OSG-delivery-checkpoint/1",
            },
        )
        redirected = MODULE.ReviewedRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://objects.example.test/tool.zip?signature=secret",
        )

        self.assertEqual(redirected.get_method(), "HEAD")
        self.assertIsNone(redirected.get_header("Authorization"))
        self.assertIsNone(redirected.get_header("Cookie"))
        self.assertIsNone(redirected.get_header("Proxy-authorization"))
        self.assertEqual(
            redirected.get_header("User-agent"),
            "OSG-delivery-checkpoint/1",
        )

    def test_redirects_strip_sensitive_headers_when_only_the_https_port_changes(self) -> None:
        request = MODULE.Request(
            "https://example.test:443/tool.zip",
            method="HEAD",
            headers={
                "Authorization": "Bearer secret",
                "Cookie": "session=secret",
                "Proxy-Authorization": "Basic secret",
                "User-Agent": "OSG-delivery-checkpoint/1",
            },
        )
        handler = MODULE.ReviewedRedirectHandler()
        redirected = handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://example.test:8443/tool.zip",
        )

        self.assertEqual(redirected.get_method(), "HEAD")
        self.assertIsNone(redirected.get_header("Authorization"))
        self.assertIsNone(redirected.get_header("Cookie"))
        self.assertIsNone(redirected.get_header("Proxy-authorization"))
        self.assertEqual(
            redirected.get_header("User-agent"),
            "OSG-delivery-checkpoint/1",
        )

        same_origin = handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://example.test/tool.zip",
        )
        self.assertEqual(same_origin.get_header("Authorization"), "Bearer secret")

    def test_redirects_reject_https_downgrade(self) -> None:
        request = MODULE.Request("https://example.test/tool.zip", method="HEAD")
        with self.assertRaises(MODULE.RemoteResponseFailure) as raised:
            MODULE.ReviewedRedirectHandler().redirect_request(
                request,
                None,
                302,
                "Found",
                {},
                "http://example.test/tool.zip",
            )
        self.assertEqual(raised.exception.error_class, "insecure-redirect")
        self.assertFalse(raised.exception.retryable)

    def test_remote_readback_retries_only_bounded_transient_failures(self) -> None:
        response = Response()
        transient = HTTPError(
            "https://example.test/tool.zip",
            503,
            "temporary",
            hdrs=None,
            fp=None,
        )
        with mock.patch.object(
            MODULE,
            "urlopen",
            side_effect=[transient, URLError("reset"), response],
        ) as opened:
            with mock.patch.object(MODULE.time, "sleep") as slept:
                actual = MODULE.perform_remote_request(
                    MODULE.Request("https://example.test/tool.zip"),
                    timeout=60,
                    source="native-tool-source",
                    tool_id="yt-dlp",
                    consume=lambda opened_response: opened_response,
                )

        self.assertIs(actual, response)
        self.assertEqual(opened.call_count, 3)
        self.assertEqual([call.args[0] for call in slept.call_args_list], [1, 2])

    def test_remote_readback_does_not_retry_permanent_http_failures(self) -> None:
        permanent = HTTPError(
            "https://example.test/missing.zip",
            404,
            "missing",
            hdrs=None,
            fp=None,
        )
        with mock.patch.object(MODULE, "urlopen", side_effect=permanent) as opened:
            with mock.patch.object(MODULE.time, "sleep") as slept:
                with self.assertRaisesRegex(
                    SystemExit,
                    "source=native-tool-source host=example.test tool=yt-dlp "
                    "status=404 errorClass=http-permanent",
                ):
                    MODULE.perform_remote_request(
                        MODULE.Request("https://example.test/missing.zip?secret=query"),
                        timeout=60,
                        source="native-tool-source",
                        tool_id="yt-dlp",
                        consume=lambda response: response,
                    )

        opened.assert_called_once()
        slept.assert_not_called()

    def test_exhausted_transient_failure_is_sanitized_and_bounded(self) -> None:
        failures = [
            URLError("credential=secret query=private")
            for _ in range(len(MODULE.REMOTE_RETRY_DELAYS_SECONDS) + 1)
        ]
        with mock.patch.object(MODULE, "urlopen", side_effect=failures) as opened:
            with mock.patch.object(MODULE.time, "sleep") as slept:
                with self.assertRaises(SystemExit) as raised:
                    MODULE.perform_remote_request(
                        MODULE.Request("https://downloads.example.test/tool.zip?token=secret"),
                        timeout=60,
                        source="native-tool-source",
                        tool_id="deno",
                        consume=lambda response: response,
                    )

        self.assertEqual(opened.call_count, 5)
        self.assertEqual(
            [call.args[0] for call in slept.call_args_list],
            list(MODULE.REMOTE_RETRY_DELAYS_SECONDS),
        )
        message = str(raised.exception)
        self.assertEqual(
            message,
            "managed-delivery remote verification failed: "
            "source=native-tool-source host=downloads.example.test "
            "tool=deno status=none errorClass=transport",
        )
        self.assertNotIn("secret", message)
        self.assertNotIn("query", message)
        self.assertNotIn("tool.zip", message)

    def test_timeout_connection_and_incomplete_read_have_stable_classes(self) -> None:
        cases = [
            (TimeoutError("secret"), "timeout"),
            (ConnectionResetError("secret"), "connection"),
            (http.client.IncompleteRead(b"", 9), "incomplete-read"),
        ]
        for failure, error_class in cases:
            with self.subTest(error_class=error_class):
                with mock.patch.object(MODULE, "urlopen", side_effect=failure):
                    with mock.patch.object(MODULE.time, "sleep"):
                        with self.assertRaises(SystemExit) as raised:
                            MODULE.perform_remote_request(
                                MODULE.Request("https://example.test/tool.zip"),
                                timeout=60,
                                source="native-tool-source",
                                tool_id="media-tools",
                                consume=lambda response: response,
                            )
                self.assertIn(f"errorClass={error_class}", str(raised.exception))
                self.assertNotIn("secret", str(raised.exception))

    def test_protocol_tls_and_io_failures_have_redacted_stable_classes(self) -> None:
        cases = [
            (http.client.BadStatusLine("token=secret"), "http-protocol"),
            (ssl.SSLError("token=secret"), "tls"),
            (OSError("token=secret"), "io"),
        ]
        for failure, error_class in cases:
            with self.subTest(error_class=error_class):
                with mock.patch.object(MODULE, "urlopen", side_effect=failure) as opened:
                    with mock.patch.object(MODULE.time, "sleep"):
                        with self.assertRaises(SystemExit) as raised:
                            MODULE.perform_remote_request(
                                MODULE.Request("https://example.test/tool.zip?token=secret"),
                                timeout=60,
                                source="native-tool-source",
                                tool_id="media-tools",
                                consume=lambda response: response,
                            )
                self.assertEqual(opened.call_count, 5)
                message = str(raised.exception)
                self.assertIn(f"errorClass={error_class}", message)
                self.assertNotIn("secret", message)
                self.assertNotIn("tool.zip", message)

    def test_expired_global_budget_fails_before_network_or_sleep(self) -> None:
        with mock.patch.object(MODULE, "urlopen") as opened:
            with mock.patch.object(MODULE.time, "sleep") as slept:
                with self.assertRaisesRegex(SystemExit, "errorClass=budget-exhausted"):
                    MODULE.perform_remote_request(
                        MODULE.Request("https://api.github.com/repos/example/release"),
                        timeout=30,
                        source="release-api",
                        consume=lambda response: response,
                        deadline=0,
                    )
        opened.assert_not_called()
        slept.assert_not_called()

    def test_successful_consume_that_finishes_after_the_deadline_is_rejected(self) -> None:
        with mock.patch.object(MODULE, "urlopen", return_value=Response()) as opened:
            with mock.patch.object(MODULE.time, "monotonic", side_effect=[0.0, 11.0]):
                with mock.patch.object(MODULE.time, "sleep") as slept:
                    with self.assertRaisesRegex(SystemExit, "errorClass=budget-exhausted"):
                        MODULE.perform_remote_request(
                            MODULE.Request("https://example.test/tool.zip"),
                            timeout=60,
                            source="native-tool-source",
                            tool_id="media-tools",
                            consume=lambda _response: "late-success",
                            deadline=10.0,
                        )
        opened.assert_called_once()
        slept.assert_not_called()

    def test_release_metadata_chunk_read_stops_at_the_absolute_deadline(self) -> None:
        response = Response(b"{}", headers={"Content-Length": "2"})
        with mock.patch.object(MODULE, "urlopen", return_value=response) as opened:
            with mock.patch.object(
                MODULE.time,
                "monotonic",
                side_effect=[0.0, 0.0, 11.0],
            ):
                with mock.patch.object(MODULE.time, "sleep") as slept:
                    with self.assertRaisesRegex(SystemExit, "errorClass=budget-exhausted"):
                        MODULE.fetch_release(deadline=10.0)
        opened.assert_called_once()
        slept.assert_not_called()
        self.assertEqual(
            response.read_calls,
            [MODULE.RELEASE_METADATA_READ_CHUNK_BYTES],
        )

    def test_release_metadata_read_is_bounded_and_oversize_is_not_retried(self) -> None:
        response = Response(
            b"",
            headers={"Content-Length": str(MODULE.RELEASE_METADATA_LIMIT_BYTES + 1)},
            forbid_read=True,
        )
        with mock.patch.object(MODULE, "urlopen", return_value=response) as opened:
            with mock.patch.object(MODULE.time, "sleep") as slept:
                with self.assertRaisesRegex(
                    SystemExit,
                    "source=release-api host=api.github.com tool=none "
                    "status=200 errorClass=response-too-large",
                ):
                    MODULE.fetch_release()
        opened.assert_called_once()
        slept.assert_not_called()

    def test_invalid_release_json_retries_then_reports_safe_attribution(self) -> None:
        responses = [
            Response(b"not-json", headers={"Content-Length": "8"})
            for _ in range(len(MODULE.REMOTE_RETRY_DELAYS_SECONDS) + 1)
        ]
        with mock.patch.object(MODULE, "urlopen", side_effect=responses) as opened:
            with mock.patch.object(MODULE.time, "sleep") as slept:
                with self.assertRaisesRegex(
                    SystemExit,
                    "source=release-api host=api.github.com tool=none "
                    "status=200 errorClass=invalid-json",
                ):
                    MODULE.fetch_release()
        self.assertEqual(opened.call_count, 5)
        self.assertEqual(slept.call_count, 4)

    def test_direct_source_readback_requires_exact_content_length(self) -> None:
        catalog = {
            "tools": [{
                "id": "yt-dlp",
                "notices": [],
                "platforms": {"windows-x86_64": {"releases": [{
                    "artifact": {
                        "sourceUrl": "https://example.test/tool.zip?private=secret",
                        "sizeBytes": 7,
                    }
                }]}},
            }]
        }

        response = Response(headers={"Content-Length": "6"}, forbid_read=True)
        with mock.patch.object(MODULE, "urlopen", return_value=response) as opened:
            with self.assertRaises(SystemExit) as raised:
                MODULE.verify_native_tool_sources(catalog)
        self.assertEqual(opened.call_args.args[0].get_method(), "HEAD")
        message = str(raised.exception)
        self.assertEqual(
            message,
            "managed-delivery remote verification failed: "
            "source=native-tool-source host=example.test "
            "tool=yt-dlp status=200 errorClass=size-mismatch",
        )
        self.assertNotIn("secret", message)
        self.assertNotIn("tool.zip", message)

    def test_source_fingerprints_ignore_checkout_line_endings(self) -> None:
        self.assertEqual(
            MODULE.canonical_source_bytes(b"first\r\nsecond\r\n"),
            b"first\nsecond\n",
        )

    def test_source_change_requires_new_delivery_identity(self) -> None:
        previous = {
            "groups": {"runtime": {"sourceSha256": "a", "deliverySha256": "same"}}
        }
        current = {
            "groups": {"runtime": {"sourceSha256": "b", "deliverySha256": "same"}}
        }
        with self.assertRaises(SystemExit):
            MODULE.assert_changed_sources_have_new_delivery(previous, current)

    def test_source_and_delivery_may_advance_together(self) -> None:
        previous = {
            "groups": {"runtime": {"sourceSha256": "a", "deliverySha256": "old"}}
        }
        current = {
            "groups": {"runtime": {"sourceSha256": "b", "deliverySha256": "new"}}
        }
        MODULE.assert_changed_sources_have_new_delivery(previous, current)

    def test_current_host_has_no_developer_runtime_escape_hatch(self) -> None:
        MODULE.assert_host_policy()

    def test_checkpoint_has_unique_content_addressed_pool_assets(self) -> None:
        checkpoint = MODULE.build_checkpoint()
        assets = checkpoint["remotePoolAssets"]
        self.assertGreater(len(assets), 0)
        self.assertEqual(len(assets), len({asset["asset"] for asset in assets}))
        for asset in assets:
            self.assertRegex(asset["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(asset["sizeBytes"], 0)


if __name__ == "__main__":
    unittest.main()
