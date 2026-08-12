from __future__ import annotations

import importlib.util
import tarfile
import tempfile
import unittest
from pathlib import Path
import zipfile


MODULE_PATH = Path(__file__).with_name("build-provider-speech-runtime.py")
LOCK_PATH = MODULE_PATH.parent.parent / "crates/osg-speech/delivery/provider-runtime-windows.lock.json"
SPEC = importlib.util.spec_from_file_location("provider_runtime_builder", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class ProviderRuntimeBuilderTests(unittest.TestCase):
    def test_checked_in_lock_has_exact_unique_closed_runtime_sets(self) -> None:
        lock = MODULE.json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            set(lock),
            {"schemaVersion", "reviewedAt", "platform", "python", "packages", "runtimes"},
        )
        self.assertEqual(lock["schemaVersion"], 1)
        self.assertEqual(lock["platform"], "windows-x86_64")
        MODULE.validate_upstream(lock["python"], python=True)
        packages = {}
        for package in lock["packages"]:
            self.assertEqual(set(package), MODULE.REQUIRED_KEYS)
            identity = MODULE.package_id(package["name"])
            self.assertNotIn(identity, packages)
            self.assertGreater(package["sizeBytes"], 0)
            self.assertRegex(package["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(package["license"])
            MODULE.validate_upstream(package, python=False)
            packages[identity] = package
        self.assertEqual(
            set(lock["runtimes"]),
            {"edge-tts", "gtts", "gemini-tts"},
        )
        used = set()
        for component, names in lock["runtimes"].items():
            with self.subTest(component=component):
                self.assertTrue(names)
                self.assertEqual(len(names), len(set(names)))
                self.assertTrue(set(names) <= set(packages))
                used.update(names)
        self.assertEqual(used, set(packages))

    def test_package_names_have_one_canonical_identity(self) -> None:
        self.assertEqual(MODULE.package_id("typing_extensions"), "typing-extensions")
        self.assertEqual(MODULE.package_id("gTTS"), "gtts")
        for value in ("", "-hidden", "trailing-", "name/path", "name space"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                MODULE.package_id(value)

    def test_relative_paths_reject_escape_and_noncanonical_forms(self) -> None:
        for value in ("", "/absolute", "../escape", "a/../b", "a//b", "a\\b"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                MODULE.checked_relative(value)

    def test_python_archive_rejects_links_and_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "python.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                link = tarfile.TarInfo("python/linked")
                link.type = tarfile.SYMTYPE
                link.linkname = "../outside"
                archive.addfile(link)
            with self.assertRaises(SystemExit):
                MODULE.extract_python(archive_path, root / "output")

    def test_wheel_rejects_data_install_scheme(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wheel = root / "unsafe.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("unsafe.data/scripts/tool.exe", b"binary")
            with self.assertRaises(SystemExit):
                MODULE.extract_wheel(
                    wheel,
                    root / "site-packages",
                    {"name": "unsafe", "version": "1.0"},
                )

    def test_every_distribution_requires_metadata_record_and_notice(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary)
            distribution = site / "example-1.0.dist-info"
            distribution.mkdir()
            (distribution / "METADATA").write_text("Name: example\n", encoding="utf-8")
            (distribution / "RECORD").write_text("", encoding="utf-8")
            with self.assertRaises(SystemExit):
                MODULE.validate_notices(site, 1)
            (distribution / "LICENSE").write_text("license", encoding="utf-8")
            MODULE.validate_notices(site, 1)

    def test_runtime_output_is_byte_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            output_a = root / "a"
            output_b = root / "b"
            runtime.mkdir()
            output_a.mkdir()
            output_b.mkdir()
            (runtime / "python.exe").write_bytes(b"python")
            package = runtime / "Lib/site-packages/example.py"
            package.parent.mkdir(parents=True)
            package.write_bytes(b"example")
            first, _ = MODULE.write_runtime(runtime, output_a, "gtts", "test", b"{}\n")
            second, _ = MODULE.write_runtime(runtime, output_b, "gtts", "test", b"{}\n")
            self.assertEqual(first.name, second.name)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            first_zip = next(output_a.glob("*.zip"))
            second_zip = next(output_b.glob("*.zip"))
            self.assertEqual(first_zip.name, second_zip.name)
            self.assertEqual(first_zip.read_bytes(), second_zip.read_bytes())
            with zipfile.ZipFile(first_zip) as archive:
                self.assertEqual(
                    [entry.date_time for entry in archive.infolist()],
                    [MODULE.FIXED_ZIP_TIME, MODULE.FIXED_ZIP_TIME, MODULE.FIXED_ZIP_TIME],
                )


if __name__ == "__main__":
    unittest.main()
