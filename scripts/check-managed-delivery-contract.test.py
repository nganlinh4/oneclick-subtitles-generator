from __future__ import annotations

import importlib.util
import io
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("check-managed-delivery-contract.py")
SPEC = importlib.util.spec_from_file_location("managed_delivery_contract", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class ManagedDeliveryContractTests(unittest.TestCase):
    def test_release_readback_uses_available_github_token(self) -> None:
        captured = []

        def open_request(request, timeout):
            captured.append((request, timeout))
            return io.BytesIO(b"{}")

        with mock.patch.dict(MODULE.os.environ, {"GITHUB_TOKEN": "test-token"}, clear=False):
            with mock.patch.object(MODULE, "urlopen", side_effect=open_request):
                MODULE.fetch_release()

        self.assertEqual(len(captured), 1)
        request, timeout = captured[0]
        self.assertEqual(timeout, 30)
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_direct_source_readback_requires_exact_content_length(self) -> None:
        catalog = {
            "tools": [{
                "notices": [],
                "platforms": {"windows-x86_64": {"releases": [{
                    "artifact": {"sourceUrl": "https://example.test/tool.zip", "sizeBytes": 7}
                }]}},
            }]
        }

        class Response:
            status = 200
            headers = {"Content-Length": "6"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with mock.patch.object(MODULE, "urlopen", return_value=Response()):
            with self.assertRaises(SystemExit):
                MODULE.verify_native_tool_sources(catalog)

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
